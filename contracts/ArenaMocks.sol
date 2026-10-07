// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * Test scaffolding for a local node; nothing here ships. The ERC-8004
 * registries (v2.0.0) are live on Arc testnet and mainnet, and these mocks copy
 * the reference behaviour, so local tests fail the way the real ones would.
 */

// ---------------------------------------------------------------------------
// ERC-8004: IdentityRegistry (the ERC-721 parts other contracts read)
// ---------------------------------------------------------------------------

/**
 * @notice Agents as ERC-721 tokens: an owner, a per-token approval and
 *         operators. The reference v2.0.0 numbers agents from 0 on `register`;
 *         `mint` lets a test pick an id.
 */
contract MockIdentityRegistry {
    uint256 private _nextId;
    mapping(uint256 => address) private _owners;
    mapping(uint256 => address) private _tokenApprovals;
    mapping(address => mapping(address => bool)) private _operatorApprovals;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    error ERC721NonexistentToken(uint256 tokenId);
    error ERC721InvalidApprover(address approver);
    error TokenExists(uint256 tokenId);

    /// @dev Like the reference: the next free id, minted to the sender.
    function register() external returns (uint256 agentId) {
        while (_owners[_nextId] != address(0)) _nextId++;
        agentId = _nextId++;
        _mintTo(msg.sender, agentId);
    }

    function mint(address to, uint256 agentId) external {
        if (_owners[agentId] != address(0)) revert TokenExists(agentId);
        _mintTo(to, agentId);
    }

    function transferFrom(address from, address to, uint256 agentId) external {
        address owner = ownerOf(agentId);
        require(from == owner, "from");
        require(
            msg.sender == owner || _operatorApprovals[owner][msg.sender] || _tokenApprovals[agentId] == msg.sender,
            "not approved"
        );
        delete _tokenApprovals[agentId];
        _owners[agentId] = to;
        emit Transfer(from, to, agentId);
    }

    function ownerOf(uint256 agentId) public view returns (address owner) {
        owner = _owners[agentId];
        if (owner == address(0)) revert ERC721NonexistentToken(agentId);
    }

    function approve(address to, uint256 agentId) external {
        address owner = ownerOf(agentId);
        if (msg.sender != owner && !_operatorApprovals[owner][msg.sender]) revert ERC721InvalidApprover(msg.sender);
        _tokenApprovals[agentId] = to;
        emit Approval(owner, to, agentId);
    }

    function setApprovalForAll(address operator, bool approved) external {
        _operatorApprovals[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function getApproved(uint256 agentId) external view returns (address) {
        ownerOf(agentId);
        return _tokenApprovals[agentId];
    }

    function isApprovedForAll(address owner, address operator) external view returns (bool) {
        return _operatorApprovals[owner][operator];
    }

    function _mintTo(address to, uint256 agentId) private {
        require(to != address(0), "zero owner");
        _owners[agentId] = to;
        emit Transfer(address(0), to, agentId);
    }
}

// ---------------------------------------------------------------------------
// ERC-8004: ValidationRegistry, as the reference v2.0.0 behaves
// ---------------------------------------------------------------------------

interface IMockIdentityRegistry {
    function ownerOf(uint256 tokenId) external view returns (address);
    function getApproved(uint256 tokenId) external view returns (address);
    function isApprovedForAll(address owner, address operator) external view returns (bool);
}

/**
 * @notice Mirrors erc-8004-contracts ValidationRegistryUpgradeable v2.0.0
 *         (the version live on Arc), minus the proxy: the same checks, the
 *         same revert strings, the same storage semantics.
 *
 *   - only the agent's owner or an approved operator may request, and each
 *     requestHash can be used once
 *   - only the named validator may respond, 0 to 100, as often as it likes;
 *     the latest response is stored and every one is emitted
 *   - `lastUpdate` is a timestamp, not a block number
 */
contract MockValidationRegistry {
    struct ValidationStatus {
        address validatorAddress;
        uint256 agentId;
        uint8 response; // 0..100
        bytes32 responseHash;
        string tag;
        uint256 lastUpdate;
        bool hasResponse;
    }

    address private immutable _identityRegistry;

    mapping(bytes32 => ValidationStatus) private _validations;
    mapping(uint256 => bytes32[]) private _agentValidations;
    mapping(address => bytes32[]) private _validatorRequests;

    event ValidationRequest(
        address indexed validatorAddress,
        uint256 indexed agentId,
        string requestURI,
        bytes32 indexed requestHash
    );
    event ValidationResponse(
        address indexed validatorAddress,
        uint256 indexed agentId,
        bytes32 indexed requestHash,
        uint8 response,
        string responseURI,
        bytes32 responseHash,
        string tag
    );

    constructor(address identityRegistry_) {
        require(identityRegistry_ != address(0), "bad identity");
        _identityRegistry = identityRegistry_;
    }

    function getIdentityRegistry() external view returns (address) {
        return _identityRegistry;
    }

    function getVersion() external pure returns (string memory) {
        return "2.0.0";
    }

    function validationRequest(
        address validatorAddress,
        uint256 agentId,
        string calldata requestURI,
        bytes32 requestHash
    ) external {
        require(validatorAddress != address(0), "bad validator");
        require(_validations[requestHash].validatorAddress == address(0), "exists");

        IMockIdentityRegistry registry = IMockIdentityRegistry(_identityRegistry);
        address owner = registry.ownerOf(agentId);
        require(
            msg.sender == owner ||
                registry.isApprovedForAll(owner, msg.sender) ||
                registry.getApproved(agentId) == msg.sender,
            "Not authorized"
        );

        _validations[requestHash] = ValidationStatus({
            validatorAddress: validatorAddress,
            agentId: agentId,
            response: 0,
            responseHash: bytes32(0),
            tag: "",
            lastUpdate: block.timestamp,
            hasResponse: false
        });
        _agentValidations[agentId].push(requestHash);
        _validatorRequests[validatorAddress].push(requestHash);

        emit ValidationRequest(validatorAddress, agentId, requestURI, requestHash);
    }

    function validationResponse(
        bytes32 requestHash,
        uint8 response,
        string calldata responseURI,
        bytes32 responseHash,
        string calldata tag
    ) external {
        ValidationStatus storage s = _validations[requestHash];
        require(s.validatorAddress != address(0), "unknown");
        require(msg.sender == s.validatorAddress, "not validator");
        require(response <= 100, "resp>100");
        s.response = response;
        s.responseHash = responseHash;
        s.tag = tag;
        s.lastUpdate = block.timestamp;
        s.hasResponse = true;
        emit ValidationResponse(s.validatorAddress, s.agentId, requestHash, response, responseURI, responseHash, tag);
    }

    function getValidationStatus(bytes32 requestHash)
        external
        view
        returns (
            address validatorAddress,
            uint256 agentId,
            uint8 response,
            bytes32 responseHash,
            string memory tag,
            uint256 lastUpdate
        )
    {
        ValidationStatus memory s = _validations[requestHash];
        require(s.validatorAddress != address(0), "unknown");
        return (s.validatorAddress, s.agentId, s.response, s.responseHash, s.tag, s.lastUpdate);
    }

    /// @dev Count and average of answered requests, optionally filtered by
    ///      validator and tag (empty filters match everything).
    function getSummary(uint256 agentId, address[] calldata validatorAddresses, string calldata tag)
        external
        view
        returns (uint64 count, uint8 avgResponse)
    {
        uint256 totalResponse;
        bytes32[] storage requestHashes = _agentValidations[agentId];

        for (uint256 i; i < requestHashes.length; i++) {
            ValidationStatus storage s = _validations[requestHashes[i]];

            bool matchValidator = (validatorAddresses.length == 0);
            if (!matchValidator) {
                for (uint256 j; j < validatorAddresses.length; j++) {
                    if (s.validatorAddress == validatorAddresses[j]) {
                        matchValidator = true;
                        break;
                    }
                }
            }
            bool matchTag = (bytes(tag).length == 0) || (keccak256(bytes(s.tag)) == keccak256(bytes(tag)));

            if (matchValidator && matchTag && s.hasResponse) {
                totalResponse += s.response;
                count++;
            }
        }
        avgResponse = count > 0 ? uint8(totalResponse / count) : 0;
    }

    function getAgentValidations(uint256 agentId) external view returns (bytes32[] memory) {
        return _agentValidations[agentId];
    }

    function getValidatorRequests(address validatorAddress) external view returns (bytes32[] memory) {
        return _validatorRequests[validatorAddress];
    }
}

// ---------------------------------------------------------------------------
// ERC-1271: a contract wallet that signs through its owner's key
// ---------------------------------------------------------------------------

/**
 * @notice The smallest smart-contract account: a signature is valid when its
 *         owner's key made it. The owner can switch it off, as a real wallet
 *         can revoke, to show a contract signature is checked live.
 */
contract MockERC1271Wallet {
    bytes4 private constant MAGIC = 0x1626ba7e; // isValidSignature.selector
    address public immutable owner;
    bool public disabled;

    constructor(address owner_) {
        owner = owner_;
    }

    function setDisabled(bool disabled_) external {
        require(msg.sender == owner, "owner");
        disabled = disabled_;
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        if (disabled || signature.length != 65) return 0xffffffff;
        bytes32 r = bytes32(signature[0:32]);
        bytes32 s = bytes32(signature[32:64]);
        uint8 v = uint8(signature[64]);
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) return 0xffffffff;
        address signer = ecrecover(hash, v, r, s);
        return signer != address(0) && signer == owner ? MAGIC : bytes4(0xffffffff);
    }
}
