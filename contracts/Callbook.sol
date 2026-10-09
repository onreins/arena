// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/**
 * @title Callbook
 * @notice A notary for trading agents: seal a call before the market moves,
 *         reveal it after, and let anyone score the record.
 *
 * An agent opens a book: the coins it may call, how often it calls (`period`),
 * how long each call is held (`horizon`), and a hash of its strategy. Then,
 * once per period and before that period starts, its key seals a hash of the
 * call: which coin, and long, short or flat. After the horizon has passed,
 * anyone holding the preimage reveals it, and the contract checks it matches.
 *
 * What the contract guarantees, and nothing more:
 *
 *   - a call was fixed before its period started (at least SEAL_LEAD seconds
 *     before the entry time, so it was never written with the entry known)
 *   - at most one call per period, and only for the upcoming period, so an
 *     agent can't stockpile alternative futures
 *   - a revealed call is exactly the one that was sealed; the hash binds this
 *     contract, the chain, the book and the period, so a seal can't be
 *     replayed from anywhere else
 *   - reveals happen only once the outcome is known, and only within GRACE
 *
 * Scoring is off-chain and reads only events. A period with no seal is a miss;
 * a seal never revealed within GRACE is the worst outcome. The contract holds
 * no funds, has no owner or admin, and makes no external calls except read-only
 * lookups in the ERC-8004 IdentityRegistry when a book links an agent.
 *
 * ## Open-call books
 *
 * A second kind of book, for calls made whenever the caller likes rather than
 * on a schedule. `openFree` fixes the coins and a range of horizons; `lock`
 * commits a call at any time, and its entry is the first whole minute at least
 * SEAL_LEAD seconds later. The horizon is public from the moment of the lock
 * (and bound in the hash too), so everyone knows when each call is due; the
 * coin and side stay hidden, and the side must be long or short: an open call
 * is a position, so "flat" means nothing here. `revealLocked` opens it after
 * entry plus that horizon, within GRACE. A free book is a Book with `period == 0`
 * and `horizon` holding the longest horizon; it announces itself with
 * `OpenedFree`, never `Opened`, and the two kinds of call never mix: seal and
 * reveal refuse free books, lock and revealLocked refuse scheduled ones.
 *
 * Every lock counts. The caller picks when to call, so the record is only
 * honest if each lock is scored, and a lock never revealed is the worst outcome.
 *
 * A lock names the id its hash was made for (`expectedId`: the call id in a
 * coin-list book, the owner's nonce in an any-coin book) and reverts with
 * StaleId if another lock got there first, instead of recording a call whose
 * hash can never match.
 *
 * ## Gasless use
 *
 * Nobody needs USDC on Arc to keep a book: `lockBySig` and `sealBySig` take an
 * EIP-712 signature (domain "Arena", version "1") and a relayer pays the
 * gas. Reveals were always permissionless, so a relayer can reveal too.
 *
 * The first `lockBySig` for an account opens its default book: a free book it
 * owns and calls with itself, horizons 5 minutes to 30 days, and no coin list
 * (`coinCount == 0`), so a call names its coin as a string. A call in such a
 * book can't commit to a book id or call id (neither is known when it is
 * signed), so its hash commits to the account and the account's nonce instead:
 * see `symbolCallHashOf`. Each lock in an any-coin book uses up one nonce of
 * the book's owner, whether it arrives signed or sent directly.
 *
 * ## Profiles
 *
 * `setProfile` (or `setProfileBySig`, relayed) names an account (bookId 0) or
 * one of its books, with a bio and a link. It only emits `Profile`: the newest
 * event is the profile. It never touches calls or scores.
 *
 * Arc timestamps have one-second resolution and never decrease, which is all a
 * deadline needs: time can only move toward it.
 */

/// The parts of the ERC-8004 IdentityRegistry (an ERC-721) this contract reads.
interface IIdentityRegistry {
    function ownerOf(uint256 agentId) external view returns (address);
    function getApproved(uint256 agentId) external view returns (address);
    function isApprovedForAll(address owner, address operator) external view returns (bool);
}

contract Callbook is EIP712 {
    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    struct Book {
        address owner; // who opened it; may rotate the caller and close it
        uint32 period; // seconds between calls; 0 marks an open-call (free) book
        uint32 horizon; // seconds each call is held; a free book's longest horizon
        uint8 coinCount;
        uint64 closedAt; // 0 while open; otherwise when it closed
        address caller; // the key allowed to seal, besides the owner
        uint64 start; // start of period 0, aligned to `period`; 0 for a free book
        uint256 agentId; // ERC-8004 agent, or NO_AGENT
        bytes32 strategyHash; // commits to the strategy's rules (metaHash for a free book)
        bytes32 coinsHash; // keccak256(abi.encode(coins))
    }

    struct Seal {
        bytes32 callHash;
        uint64 sealedAt;
        bool revealed;
        uint8 coinIndex; // meaningful once revealed
        int8 side; // -1 short, 0 flat, 1 long; meaningful once revealed
    }

    /// A call locked in a free book.
    struct Lock {
        bytes32 callHash;
        uint64 lockedAt;
        uint64 entryAt; // first whole minute at least SEAL_LEAD after lockedAt
        uint32 horizon; // public from the lock: due at entryAt + horizon
        bool revealed;
        uint8 coinIndex; // meaningful once revealed
        int8 side; // -1 short, 1 long; meaningful once revealed
        uint64 nonce; // any-coin books only: the owner's nonce this call used up
    }

    // ---------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------

    /// A call must be sealed at least this long before its period starts.
    uint64 public constant SEAL_LEAD = 60;
    /// After the horizon, a sealed call can be revealed for this long.
    uint64 public constant GRACE = 7 days;

    uint32 public constant MIN_PERIOD = 5 minutes;
    uint32 public constant MAX_PERIOD = 7 days;
    uint32 public constant MAX_HORIZON = 30 days;
    /// The shortest horizon a free book may allow.
    uint32 public constant MIN_FREE_HORIZON = 5 minutes;
    /// Periods and horizons are whole minutes, so they line up with candles.
    uint32 public constant TIME_UNIT = 1 minutes;

    /// "No ERC-8004 agent linked". Not 0: the registry numbers agents from 0.
    uint256 public constant NO_AGENT = type(uint256).max;

    uint256 public constant MAX_COINS = 32;
    uint256 public constant MAX_COIN_BYTES = 16;

    /// First field of every locked-call hash, so it can never be mistaken for
    /// a scheduled call's hash (which also differs in length).
    bytes32 public constant LOCKED_TAG = keccak256("callbook.locked");
    /// First field of an any-coin call's hash; a third, separate domain.
    bytes32 public constant SYMBOL_TAG = keccak256("callbook.locked.symbol");

    bytes32 public constant LOCK_TYPEHASH =
        keccak256("LockCall(address account,bytes32 callHash,uint32 horizon,uint256 nonce,uint256 deadline)");
    bytes32 public constant SEAL_TYPEHASH =
        keccak256("SealCall(uint256 bookId,uint64 p,bytes32 callHash,uint256 deadline)");
    bytes32 public constant PROFILE_TYPEHASH = keccak256(
        "SetProfile(address account,uint256 bookId,string name,string bio,string link,uint256 nonce,uint256 deadline)"
    );

    bytes32 public constant LINK_TYPEHASH =
        keccak256("LinkAgent(address agent,address wallet,uint256 nonce,uint256 deadline)");
    bytes32 public constant UNLINK_TYPEHASH = keccak256("UnlinkAgent(address agent,uint256 nonce,uint256 deadline)");

    /// Profile caps, in bytes. What a name may say is checked off-chain.
    uint256 public constant MAX_NAME_BYTES = 32;
    uint256 public constant MAX_BIO_BYTES = 160;
    uint256 public constant MAX_LINK_BYTES = 100;

    // ---------------------------------------------------------------------
    // State
    // ---------------------------------------------------------------------

    /// The ERC-8004 IdentityRegistry, or address(0) on a chain without one.
    IIdentityRegistry public immutable identityRegistry;

    /// Book ids start at 1.
    mapping(uint256 => Book) public books;
    uint256 private _bookCount;

    mapping(uint256 => mapping(uint64 => Seal)) private _seals;
    mapping(address => uint256[]) private _booksOf;
    mapping(uint256 => uint256[]) private _booksOfAgent;

    mapping(uint256 => mapping(uint64 => Lock)) private _locks;
    mapping(uint256 => uint64) private _lockCount;
    mapping(uint256 => uint32) private _minHorizon;

    /// The book `lockBySig` locks into for an account (0 until its first lock).
    mapping(address => uint256) public defaultBookOf;
    mapping(address => uint64) private _nonces;
    /// Separate from `nonces`: those are bound into call hashes signed ahead of time.
    mapping(address => uint256) public profileNonces;
    /// The wallet an agent's key is linked to (0 when none): its records show on that wallet's profile.
    mapping(address => address) public walletOf;
    /// Per agent: each link or unlink by signature uses one up.
    mapping(address => uint256) public linkNonces;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event Opened(
        uint256 indexed bookId,
        address indexed owner,
        uint256 indexed agentId,
        address caller,
        bytes32 strategyHash,
        string[] coins,
        uint32 period,
        uint32 horizon,
        uint64 start
    );
    event CallerSet(uint256 indexed bookId, address indexed caller);
    event Sealed(uint256 indexed bookId, uint64 indexed p, bytes32 callHash);
    event Revealed(uint256 indexed bookId, uint64 indexed p, uint8 coinIndex, int8 side);
    event Closed(uint256 indexed bookId);
    event OpenedFree(
        uint256 indexed bookId,
        address indexed owner,
        uint256 indexed agentId,
        address caller,
        bytes32 metaHash,
        string[] coins,
        uint32 minHorizon,
        uint32 maxHorizon
    );
    event Locked(uint256 indexed bookId, uint64 indexed callId, bytes32 callHash, uint64 entryAt, uint32 horizon);
    event RevealedLocked(uint256 indexed bookId, uint64 indexed callId, uint8 coinIndex, int8 side, uint32 horizon);
    event RevealedLockedSymbol(uint256 indexed bookId, uint64 indexed callId, string coin, int8 side, uint32 horizon);
    /// bookId 0 is the account itself; an empty name clears the profile.
    event Profile(address indexed account, uint256 indexed bookId, string name, string bio, string link);
    event AgentLinked(address indexed wallet, address indexed agent);
    event AgentUnlinked(address indexed wallet, address indexed agent);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error BadConfig();
    error UnknownBook(uint256 bookId);
    error NotBookOwner();
    error NotCaller();
    error BookClosed();
    error NoIdentityRegistry();
    error UnknownAgent(uint256 agentId);
    error NotAgentOwner(uint256 agentId);
    error BadCoins();
    error BadPeriod();
    error BadHorizon();
    error EmptyCall();
    error SealTooLate(uint256 startsAt, uint256 latestSealAt);
    error SealTooEarly(uint256 startsAt, uint256 earliestSealAt);
    error AlreadySealed();
    error NotSealed();
    error AlreadyRevealed();
    error RevealTooEarly(uint256 revealableAt);
    error RevealExpired(uint256 deadline);
    error BadCoinIndex();
    error BadSide();
    error WrongPreimage();
    error NotStarted(uint256 startsAt);
    error NotScheduled();
    error NotFree();
    error NotLocked();
    error WrongCoinMode();
    error SignatureExpired(uint256 deadline);
    error BadSignature();
    error StaleId(uint64 expected, uint64 actual);
    error ProfileTooLong();
    error SelfLink();
    error NotLinked();
    error NotLinkParty();

    // ---------------------------------------------------------------------
    // Setup
    // ---------------------------------------------------------------------

    constructor(IIdentityRegistry identityRegistry_) EIP712("Arena", "1") {
        if (address(identityRegistry_) != address(0) && address(identityRegistry_).code.length == 0) {
            revert BadConfig();
        }
        identityRegistry = identityRegistry_;
    }

    // ---------------------------------------------------------------------
    // Books
    // ---------------------------------------------------------------------

    /**
     * @notice Open a book. Everything but the caller is fixed for good.
     * @param agentId ERC-8004 agent to link, or NO_AGENT for none. Linking needs the
     *        agent's owner or an operator it approved.
     * @param caller The key that seals calls (the owner can always seal too).
     * @param coins 1 to 32 symbols of 1 to 16 bytes; calls name them by index.
     * @param period Seconds between calls: whole minutes, 5 minutes to 7 days.
     * @param horizon Seconds a call is held: whole minutes, period to 30 days.
     * @return bookId The new book's id.
     *
     * Period 0 starts at the first period boundary more than SEAL_LEAD seconds
     * away, so the opener always has time to seal it: from the moment the book
     * opens, or from the next second if it opened exactly SEAL_LEAD before a
     * boundary (then period 0 starts one period after that boundary).
     */
    function open(
        uint256 agentId,
        address caller,
        bytes32 strategyHash,
        string[] calldata coins,
        uint32 period,
        uint32 horizon
    ) external returns (uint256 bookId) {
        if (agentId != NO_AGENT) _checkAgent(agentId);
        _checkCoins(coins);
        if (period < MIN_PERIOD || period > MAX_PERIOD || period % TIME_UNIT != 0) revert BadPeriod();
        if (horizon < period || horizon > MAX_HORIZON || horizon % TIME_UNIT != 0) revert BadHorizon();

        uint64 start = uint64(((block.timestamp + SEAL_LEAD) / period + 1) * period);

        bookId = ++_bookCount;
        books[bookId] = Book({
            owner: msg.sender,
            period: period,
            horizon: horizon,
            coinCount: uint8(coins.length),
            closedAt: 0,
            caller: caller,
            start: start,
            agentId: agentId,
            strategyHash: strategyHash,
            coinsHash: keccak256(abi.encode(coins))
        });
        _index(msg.sender, bookId, agentId);

        emit Opened(bookId, msg.sender, agentId, caller, strategyHash, coins, period, horizon, start);
    }

    /**
     * @notice Open a book of open calls: locked whenever the caller likes.
     *         Everything but the caller is fixed for good.
     * @param agentId As for `open`.
     * @param caller The key that locks calls (the owner can always lock too).
     * @param metaHash Commits to whatever the opener wants fixed (a thesis, rules).
     * @param coins As for `open`.
     * @param minHorizon Shortest horizon a call may name: whole minutes, at least 5 minutes.
     * @param maxHorizon Longest: whole minutes, at least minHorizon, at most 30 days.
     */
    function openFree(
        uint256 agentId,
        address caller,
        bytes32 metaHash,
        string[] calldata coins,
        uint32 minHorizon,
        uint32 maxHorizon
    ) external returns (uint256 bookId) {
        if (agentId != NO_AGENT) _checkAgent(agentId);
        _checkCoins(coins);
        if (
            minHorizon < MIN_FREE_HORIZON ||
            maxHorizon < minHorizon ||
            maxHorizon > MAX_HORIZON ||
            minHorizon % TIME_UNIT != 0 ||
            maxHorizon % TIME_UNIT != 0
        ) revert BadHorizon();

        bookId = ++_bookCount;
        books[bookId] = Book({
            owner: msg.sender,
            period: 0,
            horizon: maxHorizon,
            coinCount: uint8(coins.length),
            closedAt: 0,
            caller: caller,
            start: 0,
            agentId: agentId,
            strategyHash: metaHash,
            coinsHash: keccak256(abi.encode(coins))
        });
        _minHorizon[bookId] = minHorizon;
        _index(msg.sender, bookId, agentId);

        emit OpenedFree(bookId, msg.sender, agentId, caller, metaHash, coins, minHorizon, maxHorizon);
    }

    /// @notice Rotate the key that seals calls. address(0) leaves only the owner.
    function setCaller(uint256 bookId, address caller) external {
        Book storage book = _book(bookId);
        if (msg.sender != book.owner) revert NotBookOwner();
        if (book.closedAt != 0) revert BookClosed();
        book.caller = caller;
        emit CallerSet(bookId, caller);
    }

    /// @notice Stop sealing for good. Calls already sealed can still be revealed.
    function close(uint256 bookId) external {
        Book storage book = _book(bookId);
        if (msg.sender != book.owner) revert NotBookOwner();
        if (book.closedAt != 0) revert BookClosed();
        book.closedAt = uint64(block.timestamp);
        emit Closed(bookId);
    }

    // ---------------------------------------------------------------------
    // Profiles
    // ---------------------------------------------------------------------

    /**
     * @notice Name yourself (bookId 0) or one of your books, with a short bio and
     *         a link. Only the event is kept: the newest one per account and
     *         book is the profile, and an empty name clears it. Closed books
     *         can still be named; their records stay on show.
     */
    function setProfile(uint256 bookId, string calldata name, string calldata bio, string calldata link) external {
        _setProfile(msg.sender, bookId, name, bio, link);
    }

    /**
     * @notice `setProfile`, with the gas paid by whoever submits it. The signature
     *         is EIP-712 `SetProfile(account, bookId, name, bio, link,
     *         profileNonces(account), deadline)` by `account`.
     */
    function setProfileBySig(
        address account,
        uint256 bookId,
        string calldata name,
        string calldata bio,
        string calldata link,
        uint256 deadline,
        bytes calldata signature
    ) external {
        if (block.timestamp > deadline) revert SignatureExpired(deadline);
        if (account == address(0)) revert BadSignature();
        bytes memory texts = abi.encode(keccak256(bytes(name)), keccak256(bytes(bio)), keccak256(bytes(link)));
        if (!SignatureChecker.isValidSignatureNowCalldata(account, _profileDigest(account, bookId, texts, deadline), signature)) {
            revert BadSignature();
        }
        _setProfile(account, bookId, name, bio, link);
    }

    /// Every field is one 32-byte word, so the parts concatenate to the EIP-712 struct encoding.
    function _profileDigest(address account, uint256 bookId, bytes memory texts, uint256 deadline)
        private
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(
            keccak256(
                bytes.concat(
                    abi.encode(PROFILE_TYPEHASH, account, bookId), texts, abi.encode(profileNonces[account], deadline)
                )
            )
        );
    }

    function _setProfile(
        address account,
        uint256 bookId,
        string calldata name,
        string calldata bio,
        string calldata link
    ) private {
        if (bookId != 0 && _book(bookId).owner != account) revert NotBookOwner();
        if (
            bytes(name).length > MAX_NAME_BYTES || bytes(bio).length > MAX_BIO_BYTES
                || bytes(link).length > MAX_LINK_BYTES
        ) revert ProfileTooLong();
        profileNonces[account]++;
        emit Profile(account, bookId, name, bio, link);
    }

    // ---------------------------------------------------------------------
    // Agents linked to a wallet
    // ---------------------------------------------------------------------

    /**
     * @notice Link an agent's key to a person's wallet, so the agent's records
     *         show on that wallet's profile. Both sign the same EIP-712
     *         `LinkAgent(agent, wallet, linkNonces(agent), deadline)`, so neither
     *         can link the other alone. Anyone may submit it (a relayer pays).
     *         An agent has one wallet at a time: linking again replaces it.
     *         Nothing here touches calls or scores.
     */
    function linkBySig(address agent, address wallet, uint256 deadline, bytes calldata agentSig, bytes calldata walletSig)
        external
    {
        if (block.timestamp > deadline) revert SignatureExpired(deadline);
        if (agent == address(0) || wallet == address(0)) revert BadSignature();
        if (agent == wallet) revert SelfLink();
        bytes32 digest =
            _hashTypedDataV4(keccak256(abi.encode(LINK_TYPEHASH, agent, wallet, linkNonces[agent], deadline)));
        if (!SignatureChecker.isValidSignatureNowCalldata(agent, digest, agentSig)) revert BadSignature();
        if (!SignatureChecker.isValidSignatureNowCalldata(wallet, digest, walletSig)) revert BadSignature();
        linkNonces[agent]++;
        address old = walletOf[agent];
        if (old != address(0) && old != wallet) emit AgentUnlinked(old, agent);
        walletOf[agent] = wallet;
        emit AgentLinked(wallet, agent);
    }

    /// @notice Unlink an agent from its wallet. Either side may.
    function unlink(address agent) external {
        address wallet = walletOf[agent];
        if (wallet == address(0)) revert NotLinked();
        if (msg.sender != agent && msg.sender != wallet) revert NotLinkParty();
        _unlink(agent, wallet);
    }

    /**
     * @notice `unlink`, with the gas paid by whoever submits it. `signer` is the
     *         agent or its wallet; it signs EIP-712
     *         `UnlinkAgent(agent, linkNonces(agent), deadline)`.
     */
    function unlinkBySig(address agent, address signer, uint256 deadline, bytes calldata signature) external {
        if (block.timestamp > deadline) revert SignatureExpired(deadline);
        address wallet = walletOf[agent];
        if (wallet == address(0)) revert NotLinked();
        if (signer != agent && signer != wallet) revert NotLinkParty();
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(UNLINK_TYPEHASH, agent, linkNonces[agent], deadline)));
        if (!SignatureChecker.isValidSignatureNowCalldata(signer, digest, signature)) revert BadSignature();
        _unlink(agent, wallet);
    }

    function _unlink(address agent, address wallet) private {
        linkNonces[agent]++;
        delete walletOf[agent];
        emit AgentUnlinked(wallet, agent);
    }

    // ---------------------------------------------------------------------
    // Calls
    // ---------------------------------------------------------------------

    /**
     * @notice Seal the call for period `p`, which must be the upcoming one:
     *         it starts no sooner than SEAL_LEAD seconds from now, and less
     *         than one period plus SEAL_LEAD from now. The windows of
     *         consecutive periods don't overlap, so exactly one period is
     *         sealable at any second.
     * @param callHash callHashOf(this, chainid, bookId, p, coinIndex, side, salt)
     */
    function seal(uint256 bookId, uint64 p, bytes32 callHash) external {
        Book storage book = _book(bookId);
        if (book.period == 0) revert NotScheduled();
        if (msg.sender != book.caller && msg.sender != book.owner) revert NotCaller();
        _seal(book, bookId, p, callHash);
    }

    /**
     * @notice `seal`, with the gas paid by whoever submits it. The signature is
     *         EIP-712 `SealCall(bookId, p, callHash, deadline)` by the book's
     *         caller or owner. It needs no nonce: a period is sealed once.
     */
    function sealBySig(uint256 bookId, uint64 p, bytes32 callHash, uint256 deadline, bytes calldata signature)
        external
    {
        Book storage book = _book(bookId);
        if (book.period == 0) revert NotScheduled();
        if (block.timestamp > deadline) revert SignatureExpired(deadline);
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(SEAL_TYPEHASH, bookId, p, callHash, deadline)));
        address caller = book.caller;
        bool byCaller = caller != address(0) && SignatureChecker.isValidSignatureNowCalldata(caller, digest, signature);
        if (!byCaller && !SignatureChecker.isValidSignatureNowCalldata(book.owner, digest, signature)) {
            revert BadSignature();
        }
        _seal(book, bookId, p, callHash);
    }

    function _seal(Book storage book, uint256 bookId, uint64 p, bytes32 callHash) private {
        if (book.closedAt != 0) revert BookClosed();
        if (callHash == bytes32(0)) revert EmptyCall();

        uint256 startsAt = _startOf(book, p);
        if (block.timestamp + SEAL_LEAD > startsAt) revert SealTooLate(startsAt, startsAt - SEAL_LEAD);
        if (startsAt >= block.timestamp + book.period + SEAL_LEAD) {
            revert SealTooEarly(startsAt, startsAt - book.period - SEAL_LEAD + 1);
        }

        Seal storage s = _seals[bookId][p];
        if (s.callHash != bytes32(0)) revert AlreadySealed();
        s.callHash = callHash;
        s.sealedAt = uint64(block.timestamp);

        emit Sealed(bookId, p, callHash);
    }

    /**
     * @notice Reveal a sealed call. Anyone with the preimage may, once the
     *         horizon has passed and until GRACE after it.
     */
    function reveal(uint256 bookId, uint64 p, uint8 coinIndex, int8 side, bytes32 salt) external {
        Book storage book = _book(bookId);
        if (book.period == 0) revert NotScheduled();
        Seal storage s = _seals[bookId][p];
        if (s.callHash == bytes32(0)) revert NotSealed();
        if (s.revealed) revert AlreadyRevealed();

        uint256 exitAt = _startOf(book, p) + book.horizon;
        if (block.timestamp < exitAt) revert RevealTooEarly(exitAt);
        if (block.timestamp > exitAt + GRACE) revert RevealExpired(exitAt + GRACE);

        if (coinIndex >= book.coinCount) revert BadCoinIndex();
        if (side < -1 || side > 1) revert BadSide();
        if (callHashOf(address(this), block.chainid, bookId, p, coinIndex, side, salt) != s.callHash) {
            revert WrongPreimage();
        }

        s.revealed = true;
        s.coinIndex = coinIndex;
        s.side = side;

        emit Revealed(bookId, p, coinIndex, side);
    }

    /// @notice The hash a caller seals. Everything that names the call is in it.
    function callHashOf(
        address callbook,
        uint256 chainId,
        uint256 bookId,
        uint64 p,
        uint8 coinIndex,
        int8 side,
        bytes32 salt
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(callbook, chainId, bookId, p, coinIndex, side, salt));
    }

    /**
     * @notice Lock a call in a free book, now. It enters at the first whole
     *         minute at least SEAL_LEAD seconds away and is due `horizon` later.
     * @param callHash In a coin-list book, lockedHashOf(this, chainid, bookId,
     *        callId, coinIndex, side, horizon, salt) with callId = lockCount(bookId).
     *        In an any-coin book, symbolCallHashOf(this, chainid, owner, nonce,
     *        coin, side, horizon, salt) with nonce = nonces(owner).
     * @param horizon Seconds the call is held: whole minutes, within horizonBounds(bookId).
     * @param expectedId The callId (coin-list book) or nonce (any-coin book) the
     *        hash was made for; a mismatch reverts with StaleId.
     * @return callId The call's id in this book, counting from 0.
     */
    function lock(uint256 bookId, bytes32 callHash, uint32 horizon, uint64 expectedId)
        external
        returns (uint64 callId)
    {
        Book storage book = _book(bookId);
        if (book.period != 0) revert NotFree();
        if (msg.sender != book.caller && msg.sender != book.owner) revert NotCaller();
        uint64 actual = book.coinCount == 0 ? _nonces[book.owner] : _lockCount[bookId];
        if (expectedId != actual) revert StaleId(expectedId, actual);
        callId = _lock(book, bookId, callHash, horizon);
    }

    /**
     * @notice Lock a call for `account` in its default book, with the gas paid
     *         by whoever submits it. The first one opens that book.
     * @param callHash symbolCallHashOf(this, chainid, account, nonces(account), coin, side, horizon, salt)
     * @param horizon Seconds the call is held: whole minutes, 5 minutes to 30 days.
     * @param signature EIP-712 `LockCall(account, callHash, horizon, nonces(account), deadline)`
     *        by `account` (an EOA, or a contract wallet through ERC-1271).
     */
    function lockBySig(address account, bytes32 callHash, uint32 horizon, uint256 deadline, bytes calldata signature)
        external
        returns (uint256 bookId, uint64 callId)
    {
        if (block.timestamp > deadline) revert SignatureExpired(deadline);
        if (account == address(0)) revert BadSignature();
        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(LOCK_TYPEHASH, account, callHash, horizon, uint256(_nonces[account]), deadline))
        );
        if (!SignatureChecker.isValidSignatureNowCalldata(account, digest, signature)) revert BadSignature();

        bookId = defaultBookOf[account];
        if (bookId == 0 || books[bookId].closedAt != 0) bookId = _openDefault(account);
        callId = _lock(books[bookId], bookId, callHash, horizon); // uses up the nonce just signed
    }

    function _lock(Book storage book, uint256 bookId, bytes32 callHash, uint32 horizon)
        private
        returns (uint64 callId)
    {
        if (book.closedAt != 0) revert BookClosed();
        if (callHash == bytes32(0)) revert EmptyCall();
        if (horizon < _minHorizon[bookId] || horizon > book.horizon || horizon % TIME_UNIT != 0) revert BadHorizon();

        uint64 entryAt = uint64(((block.timestamp + SEAL_LEAD + TIME_UNIT - 1) / TIME_UNIT) * TIME_UNIT);
        callId = _lockCount[bookId]++;
        Lock storage l = _locks[bookId][callId];
        l.callHash = callHash;
        l.lockedAt = uint64(block.timestamp);
        l.entryAt = entryAt;
        l.horizon = horizon;
        if (book.coinCount == 0) l.nonce = _nonces[book.owner]++;

        emit Locked(bookId, callId, callHash, entryAt, horizon);
    }

    /// An account's default book: a free, any-coin book it owns and calls with itself.
    function _openDefault(address account) private returns (uint256 bookId) {
        bookId = ++_bookCount;
        books[bookId] = Book({
            owner: account,
            period: 0,
            horizon: MAX_HORIZON,
            coinCount: 0,
            closedAt: 0,
            caller: account,
            start: 0,
            agentId: NO_AGENT,
            strategyHash: bytes32(0),
            coinsHash: bytes32(0)
        });
        _minHorizon[bookId] = MIN_FREE_HORIZON;
        defaultBookOf[account] = bookId;
        _index(account, bookId, NO_AGENT);

        emit OpenedFree(bookId, account, NO_AGENT, account, bytes32(0), new string[](0), MIN_FREE_HORIZON, MAX_HORIZON);
    }

    /**
     * @notice Reveal a locked call. Anyone with the preimage may, once its
     *         horizon has passed and until GRACE after it.
     */
    function revealLocked(uint256 bookId, uint64 callId, uint8 coinIndex, int8 side, bytes32 salt) external {
        Book storage book = _book(bookId);
        if (book.period != 0) revert NotFree();
        if (book.coinCount == 0) revert WrongCoinMode();
        Lock storage l = _dueLock(bookId, callId);
        uint32 horizon = l.horizon;

        if (coinIndex >= book.coinCount) revert BadCoinIndex();
        if (side != -1 && side != 1) revert BadSide();
        if (lockedHashOf(address(this), block.chainid, bookId, callId, coinIndex, side, horizon, salt) != l.callHash) {
            revert WrongPreimage();
        }

        l.revealed = true;
        l.coinIndex = coinIndex;
        l.side = side;

        emit RevealedLocked(bookId, callId, coinIndex, side, horizon);
    }

    /**
     * @notice Reveal a call in an any-coin book (one opened by `lockBySig`).
     *         Anyone with the preimage may, on the same clock as revealLocked.
     */
    function revealLockedSymbol(uint256 bookId, uint64 callId, string calldata coin, int8 side, bytes32 salt)
        external
    {
        Book storage book = _book(bookId);
        if (book.period != 0) revert NotFree();
        if (book.coinCount != 0) revert WrongCoinMode();
        Lock storage l = _dueLock(bookId, callId);
        uint32 horizon = l.horizon;

        uint256 len = bytes(coin).length;
        if (len == 0 || len > MAX_COIN_BYTES) revert BadCoins();
        if (side != -1 && side != 1) revert BadSide();
        if (symbolCallHashOf(address(this), block.chainid, book.owner, l.nonce, coin, side, horizon, salt) != l.callHash) {
            revert WrongPreimage();
        }

        l.revealed = true;
        l.side = side;

        emit RevealedLockedSymbol(bookId, callId, coin, side, horizon);
    }

    /// A locked call that exists, is unrevealed, and is due: entryAt + horizon <= now <= that + GRACE.
    function _dueLock(uint256 bookId, uint64 callId) private view returns (Lock storage l) {
        if (callId >= _lockCount[bookId]) revert NotLocked();
        l = _locks[bookId][callId];
        if (l.revealed) revert AlreadyRevealed();

        uint256 exitAt = uint256(l.entryAt) + l.horizon;
        if (block.timestamp < exitAt) revert RevealTooEarly(exitAt);
        if (block.timestamp > exitAt + GRACE) revert RevealExpired(exitAt + GRACE);
    }

    /**
     * @notice The hash of a call in an any-coin book. It names the book's owner
     *         and the nonce the lock will use up, both known before signing,
     *         instead of a book id and call id, which aren't.
     */
    function symbolCallHashOf(
        address callbook,
        uint256 chainId,
        address account,
        uint64 nonce,
        string memory coin,
        int8 side,
        uint32 horizon,
        bytes32 salt
    ) public pure returns (bytes32) {
        return keccak256(
            abi.encode(SYMBOL_TAG, callbook, chainId, account, nonce, keccak256(bytes(coin)), side, horizon, salt)
        );
    }

    /// @notice The hash a free book's caller locks. Tagged, so it can't collide with callHashOf.
    function lockedHashOf(
        address callbook,
        uint256 chainId,
        uint256 bookId,
        uint64 callId,
        uint8 coinIndex,
        int8 side,
        uint32 horizon,
        bytes32 salt
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(LOCKED_TAG, callbook, chainId, bookId, callId, coinIndex, side, horizon, salt));
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function bookCount() external view returns (uint256) {
        return _bookCount;
    }

    /// @notice When period `p` starts (its entry time). Exit is this plus horizon.
    function startOf(uint256 bookId, uint64 p) external view returns (uint256) {
        return _startOf(_scheduled(bookId), p);
    }

    /// @notice The period under way now. Reverts before period 0 has started.
    function currentPeriod(uint256 bookId) external view returns (uint64) {
        Book storage book = _scheduled(bookId);
        if (block.timestamp < book.start) revert NotStarted(book.start);
        return uint64((block.timestamp - book.start) / book.period);
    }

    /**
     * @notice The upcoming period: the first that starts at least SEAL_LEAD
     *         from now. Its seal window (startOf - period - SEAL_LEAD, startOf
     *         - SEAL_LEAD] contains now, so sealing it succeeds, except in the
     *         one second a book opens exactly SEAL_LEAD before a boundary,
     *         when period 0's window opens a second later.
     */
    function sealablePeriod(uint256 bookId) external view returns (uint64) {
        Book storage book = _scheduled(bookId);
        uint256 earliestStart = block.timestamp + SEAL_LEAD;
        if (earliestStart <= book.start) return 0;
        return uint64((earliestStart - book.start + book.period - 1) / book.period);
    }

    function sealOf(uint256 bookId, uint64 p) external view returns (Seal memory) {
        return _seals[bookId][p];
    }

    /// @notice True for an open-call book, false for a scheduled one.
    function isFree(uint256 bookId) external view returns (bool) {
        return _book(bookId).period == 0;
    }

    /// @notice The horizons a call may name. For a scheduled book, both are its horizon.
    function horizonBounds(uint256 bookId) external view returns (uint32 minHorizon, uint32 maxHorizon) {
        Book storage book = _book(bookId);
        maxHorizon = book.horizon;
        minHorizon = book.period == 0 ? _minHorizon[bookId] : maxHorizon;
    }

    /// @notice True for a book whose calls name their coin as a string (see lockBySig).
    function isAnyCoin(uint256 bookId) external view returns (bool) {
        return _book(bookId).coinCount == 0;
    }

    /// @notice The nonce the account's next lock in an any-coin book will use.
    function nonces(address account) external view returns (uint256) {
        return _nonces[account];
    }

    /// @notice The EIP-712 domain separator signatures are made against.
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function lockCount(uint256 bookId) external view returns (uint64) {
        return _lockCount[bookId];
    }

    function lockedOf(uint256 bookId, uint64 callId) external view returns (Lock memory) {
        return _locks[bookId][callId];
    }

    function booksOf(address owner) external view returns (uint256[] memory) {
        return _booksOf[owner];
    }

    function booksOfAgent(uint256 agentId) external view returns (uint256[] memory) {
        return _booksOfAgent[agentId];
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    function _book(uint256 bookId) private view returns (Book storage book) {
        book = books[bookId];
        if (book.owner == address(0)) revert UnknownBook(bookId);
    }

    function _scheduled(uint256 bookId) private view returns (Book storage book) {
        book = _book(bookId);
        if (book.period == 0) revert NotScheduled();
    }

    function _index(address owner, uint256 bookId, uint256 agentId) private {
        _booksOf[owner].push(bookId);
        if (agentId != NO_AGENT) _booksOfAgent[agentId].push(bookId);
    }

    function _startOf(Book storage book, uint64 p) private view returns (uint256) {
        return uint256(book.start) + uint256(p) * book.period;
    }

    /// The sender must own the agent, or be approved for it, in ERC-8004.
    function _checkAgent(uint256 agentId) private view {
        IIdentityRegistry registry = identityRegistry;
        if (address(registry) == address(0)) revert NoIdentityRegistry();

        address agentOwner;
        try registry.ownerOf(agentId) returns (address o) {
            agentOwner = o;
        } catch {
            revert UnknownAgent(agentId);
        }
        if (agentOwner == address(0)) revert UnknownAgent(agentId);
        if (msg.sender == agentOwner) return;
        if (registry.isApprovedForAll(agentOwner, msg.sender)) return;
        if (registry.getApproved(agentId) == msg.sender) return;
        revert NotAgentOwner(agentId);
    }

    function _checkCoins(string[] calldata coins) private pure {
        uint256 n = coins.length;
        if (n == 0 || n > MAX_COINS) revert BadCoins();
        for (uint256 i; i < n; ++i) {
            uint256 len = bytes(coins[i]).length;
            if (len == 0 || len > MAX_COIN_BYTES) revert BadCoins();
        }
    }
}
