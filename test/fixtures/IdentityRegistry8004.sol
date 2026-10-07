// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @notice A local stand-in for erc-8004-contracts IdentityRegistryUpgradeable
 *         v2.0.0 (the version live on Arc testnet and mainnet), used by
 *         scripts/callbook-local-chain.js and test/callbook-setup.test.js.
 *
 * Same external surface the Callbook setup touches: the three `register`
 * overloads, `Registered` / `MetadataSet` / `URIUpdated` events, `tokenURI`,
 * `setAgentURI`, `getMetadata` / `setMetadata` (with `agentWallet` reserved),
 * `getAgentWallet`, ERC-721 ownership and approvals, ids from 0 upwards.
 *
 * Same storage location for ERC-721 owners as OpenZeppelin's
 * ERC721Upgradeable (ERC-7201 slot below), so a dry run can fake ownership of
 * a not-yet-minted agent with an eth_call state override exactly as it does on
 * Arc. Not included: the proxy, EIP-712 `setAgentWallet`, and the ERC-721
 * metadata name/symbol beyond what the setup reads.
 *
 * Lives under test/fixtures (not contracts/) so `npm run build` and the
 * deployable set are unchanged; it is compiled on demand with solc.
 */
interface IERC721Receiver8004 {
    function onERC721Received(address operator, address from, uint256 tokenId, bytes calldata data)
        external
        returns (bytes4);
}

contract IdentityRegistry8004 {
    struct MetadataEntry {
        string metadataKey;
        bytes metadataValue;
    }

    /// @custom:storage-location erc7201:openzeppelin.storage.ERC721 (same layout as ERC721Upgradeable)
    struct ERC721Storage {
        string _name;
        string _symbol;
        mapping(uint256 => address) _owners;
        mapping(address => uint256) _balances;
        mapping(uint256 => address) _tokenApprovals;
        mapping(address => mapping(address => bool)) _operatorApprovals;
    }

    struct IdentityStorage {
        uint256 _lastId;
        mapping(uint256 => mapping(string => bytes)) _metadata;
        mapping(uint256 => string) _uris;
    }

    bytes32 private constant ERC721_STORAGE = 0x80bb2b638cc20bc4d0a60d66940f3ab4a00c1d7b313497ca82fb0b4ab0079300;
    bytes32 private constant IDENTITY_STORAGE = 0xa040f782729de4970518741823ec1276cbcd41a0c7493f62d173341566a04e00;
    bytes32 private constant AGENT_WALLET = keccak256("agentWallet");

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);
    event Registered(uint256 indexed agentId, string agentURI, address indexed owner);
    event MetadataSet(uint256 indexed agentId, string indexed indexedMetadataKey, string metadataKey, bytes metadataValue);
    event URIUpdated(uint256 indexed agentId, string newURI, address indexed updatedBy);

    error ERC721NonexistentToken(uint256 tokenId);
    error ERC721InvalidReceiver(address receiver);

    function _erc721() private pure returns (ERC721Storage storage $) {
        bytes32 slot = ERC721_STORAGE;
        assembly {
            $.slot := slot
        }
    }

    function _id() private pure returns (IdentityStorage storage $) {
        bytes32 slot = IDENTITY_STORAGE;
        assembly {
            $.slot := slot
        }
    }

    // ------------------------------------------------------------ registration

    function register() external returns (uint256 agentId) {
        agentId = _mintAgent("");
    }

    function register(string memory agentURI) external returns (uint256 agentId) {
        agentId = _mintAgent(agentURI);
    }

    function register(string memory agentURI, MetadataEntry[] memory metadata) external returns (uint256 agentId) {
        agentId = _mintAgent(agentURI);
        for (uint256 i; i < metadata.length; i++) {
            require(keccak256(bytes(metadata[i].metadataKey)) != AGENT_WALLET, "reserved key");
            _id()._metadata[agentId][metadata[i].metadataKey] = metadata[i].metadataValue;
            emit MetadataSet(agentId, metadata[i].metadataKey, metadata[i].metadataKey, metadata[i].metadataValue);
        }
    }

    function _mintAgent(string memory agentURI) private returns (uint256 agentId) {
        IdentityStorage storage $ = _id();
        agentId = $._lastId++;
        $._metadata[agentId]["agentWallet"] = abi.encodePacked(msg.sender);
        ERC721Storage storage e = _erc721();
        e._owners[agentId] = msg.sender;
        e._balances[msg.sender] += 1;
        emit Transfer(address(0), msg.sender, agentId);
        if (msg.sender.code.length > 0) {
            try IERC721Receiver8004(msg.sender).onERC721Received(msg.sender, address(0), agentId, "") returns (bytes4 r) {
                if (r != IERC721Receiver8004.onERC721Received.selector) revert ERC721InvalidReceiver(msg.sender);
            } catch {
                revert ERC721InvalidReceiver(msg.sender);
            }
        }
        if (bytes(agentURI).length > 0) $._uris[agentId] = agentURI;
        emit Registered(agentId, agentURI, msg.sender);
        emit MetadataSet(agentId, "agentWallet", "agentWallet", abi.encodePacked(msg.sender));
    }

    // ------------------------------------------------------------ URI and metadata

    function tokenURI(uint256 agentId) external view returns (string memory) {
        ownerOf(agentId);
        return _id()._uris[agentId];
    }

    function setAgentURI(uint256 agentId, string calldata newURI) external {
        _checkAuthorized(agentId);
        _id()._uris[agentId] = newURI;
        emit URIUpdated(agentId, newURI, msg.sender);
    }

    function getMetadata(uint256 agentId, string memory metadataKey) external view returns (bytes memory) {
        return _id()._metadata[agentId][metadataKey];
    }

    function setMetadata(uint256 agentId, string memory metadataKey, bytes memory metadataValue) external {
        _checkAuthorized(agentId);
        require(keccak256(bytes(metadataKey)) != AGENT_WALLET, "reserved key");
        _id()._metadata[agentId][metadataKey] = metadataValue;
        emit MetadataSet(agentId, metadataKey, metadataKey, metadataValue);
    }

    function getAgentWallet(uint256 agentId) external view returns (address) {
        return address(bytes20(_id()._metadata[agentId]["agentWallet"]));
    }

    function getVersion() external pure returns (string memory) {
        return "2.0.0";
    }

    // ------------------------------------------------------------ ERC-721

    function ownerOf(uint256 agentId) public view returns (address owner) {
        owner = _erc721()._owners[agentId];
        if (owner == address(0)) revert ERC721NonexistentToken(agentId);
    }

    function balanceOf(address owner) external view returns (uint256) {
        return _erc721()._balances[owner];
    }

    function getApproved(uint256 agentId) public view returns (address) {
        ownerOf(agentId);
        return _erc721()._tokenApprovals[agentId];
    }

    function isApprovedForAll(address owner, address operator) public view returns (bool) {
        return _erc721()._operatorApprovals[owner][operator];
    }

    function approve(address to, uint256 agentId) external {
        address owner = ownerOf(agentId);
        require(msg.sender == owner || isApprovedForAll(owner, msg.sender), "Not authorized");
        _erc721()._tokenApprovals[agentId] = to;
        emit Approval(owner, to, agentId);
    }

    function setApprovalForAll(address operator, bool approved) external {
        _erc721()._operatorApprovals[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function transferFrom(address from, address to, uint256 agentId) external {
        address owner = ownerOf(agentId);
        require(from == owner && to != address(0), "bad transfer");
        _checkAuthorized(agentId);
        ERC721Storage storage e = _erc721();
        delete e._tokenApprovals[agentId];
        e._balances[from] -= 1;
        e._balances[to] += 1;
        e._owners[agentId] = to;
        _id()._metadata[agentId]["agentWallet"] = "";
        emit MetadataSet(agentId, "agentWallet", "agentWallet", "");
        emit Transfer(from, to, agentId);
    }

    function _checkAuthorized(uint256 agentId) private view {
        address owner = ownerOf(agentId);
        require(
            msg.sender == owner || isApprovedForAll(owner, msg.sender) || msg.sender == getApproved(agentId),
            "Not authorized"
        );
    }
}
