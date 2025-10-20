pragma solidity ^0.8.24;
import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract AdventureGameKitFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    error NotOwner();
    error NotProvider();
    error Paused();
    error CooldownActive();
    error BatchClosed();
    error InvalidCooldown();
    error ReplayAttempt();
    error StateMismatch();
    error InvalidProof();
    error NotInitialized();
    error InvalidBatch();

    address public owner;
    mapping(address => bool) public isProvider;
    bool public paused;
    uint256 public cooldownSeconds;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;

    struct Batch {
        bool isOpen;
        uint256 createdAt;
    }
    mapping(uint256 => Batch) public batches;
    uint256 public currentBatchId;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event Paused(address indexed account);
    event Unpaused(address indexed account);
    event CooldownSet(uint256 oldCooldown, uint256 newCooldown);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event PlayerStateSubmitted(address indexed player, uint256 indexed batchId, euint32 encryptedState);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId, bytes32 stateHash);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, uint256[2] decryptedValues);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    modifier submissionCooldown(address submitter) {
        if (block.timestamp < lastSubmissionTime[submitter] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    modifier decryptionCooldown(address requester) {
        if (block.timestamp < lastDecryptionRequestTime[requester] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    constructor() {
        owner = msg.sender;
        isProvider[owner] = true;
        currentBatchId = 1; // Start with batch 1
        _openBatch(currentBatchId);
        cooldownSeconds = 60; // Default 1 minute cooldown
    }

    function transferOwnership(address newOwner) external onlyOwner {
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function addProvider(address provider) external onlyOwner {
        if (!isProvider[provider]) {
            isProvider[provider] = true;
            emit ProviderAdded(provider);
        }
    }

    function removeProvider(address provider) external onlyOwner {
        if (isProvider[provider]) {
            isProvider[provider] = false;
            emit ProviderRemoved(provider);
        }
    }

    function pause() external onlyOwner whenNotPaused {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused(msg.sender);
    }

    function setCooldown(uint256 newCooldownSeconds) external onlyOwner {
        if (newCooldownSeconds == 0) revert InvalidCooldown();
        emit CooldownSet(cooldownSeconds, newCooldownSeconds);
        cooldownSeconds = newCooldownSeconds;
    }

    function openBatch() external onlyOwner {
        currentBatchId++;
        _openBatch(currentBatchId);
    }

    function _openBatch(uint256 batchId) internal {
        if (batchId == 0) revert InvalidBatch();
        batches[batchId] = Batch({ isOpen: true, createdAt: block.timestamp });
        emit BatchOpened(batchId);
    }

    function closeBatch(uint256 batchId) external onlyOwner {
        if (!batches[batchId].isOpen) revert BatchClosed();
        batches[batchId].isOpen = false;
        emit BatchClosed(batchId);
    }

    function submitPlayerState(
        address player,
        euint32 encryptedHealth,
        euint32 encryptedScore
    ) external onlyProvider whenNotPaused submissionCooldown(player) {
        if (!batches[currentBatchId].isOpen) revert BatchClosed();
        _initIfNeeded(encryptedHealth);
        _initIfNeeded(encryptedScore);

        // In a real game, these would be stored, e.g.:
        // playerStates[player][currentBatchId] = [encryptedHealth, encryptedScore];
        // For this example, we just emit them.
        emit PlayerStateSubmitted(player, currentBatchId, encryptedHealth);
        emit PlayerStateSubmitted(player, currentBatchId, encryptedScore); // Emitting score separately for clarity

        lastSubmissionTime[player] = block.timestamp;
    }

    function requestPlayerSummaryDecryption(address player, uint256 batchId) external whenNotPaused decryptionCooldown(msg.sender) {
        if (batchId == 0 || batchId > currentBatchId || !batches[batchId].isOpen) revert InvalidBatch();
        // In a real game, fetch encryptedHealth and encryptedScore for player/batchId from storage
        // For this example, we'll use dummy initialized values.
        euint32 encryptedHealth = FHE.asEuint32(0); // Placeholder
        euint32 encryptedScore = FHE.asEuint32(0); // Placeholder
        _initIfNeeded(encryptedHealth);
        _initIfNeeded(encryptedScore);

        euint32 encryptedTotal = encryptedHealth.add(encryptedScore);
        ebool encryptedIsHealthy = encryptedHealth.ge(FHE.asEuint32(50)); // Example: health >= 50

        bytes32[] memory cts = new bytes32[](3);
        cts[0] = encryptedHealth.toBytes32();
        cts[1] = encryptedScore.toBytes32();
        cts[2] = encryptedIsHealthy.toBytes32(); // Store ebool as bytes32

        bytes32 stateHash = _hashCiphertexts(cts);

        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);
        decryptionContexts[requestId] = DecryptionContext({ batchId: batchId, stateHash: stateHash, processed: false });
        emit DecryptionRequested(requestId, batchId, stateHash);

        lastDecryptionRequestTime[msg.sender] = block.timestamp;
    }

    function myCallback(uint256 requestId, bytes memory cleartexts, bytes memory proof) public {
        if (decryptionContexts[requestId].processed) revert ReplayAttempt();

        // Rebuild ciphertexts from current storage for state verification
        // This part is crucial: the ciphertexts MUST be rebuilt in the exact same order
        // and from the same data that was used when requestDecryption was called.
        // For this example, we'll use dummy initialized values as in requestPlayerSummaryDecryption.
        euint32 encryptedHealth = FHE.asEuint32(0); // Placeholder
        euint32 encryptedScore = FHE.asEuint32(0); // Placeholder
        _initIfNeeded(encryptedHealth);
        _initIfNeeded(encryptedScore);
        euint32 encryptedTotal = encryptedHealth.add(encryptedScore);
        ebool encryptedIsHealthy = encryptedHealth.ge(FHE.asEuint32(50));

        bytes32[] memory cts = new bytes32[](3);
        cts[0] = encryptedHealth.toBytes32();
        cts[1] = encryptedScore.toBytes32();
        cts[2] = encryptedIsHealthy.toBytes32();

        bytes32 currentHash = _hashCiphertexts(cts);
        if (currentHash != decryptionContexts[requestId].stateHash) {
            revert StateMismatch();
        }

        FHE.checkSignatures(requestId, cleartexts, proof); // Will revert on invalid proof

        // Decode cleartexts (order must match cts array)
        // Each euint32 is 32 bytes, ebool is 1 byte (padded to 32)
        uint256 health = abi.decode(cleartexts[0:32], (uint256));
        uint256 score = abi.decode(cleartexts[32:64], (uint256));
        bool isHealthy = abi.decode(cleartexts[64:96], (bool));

        decryptionContexts[requestId].processed = true;
        emit DecryptionCompleted(requestId, decryptionContexts[requestId].batchId, [health, score, isHealthy ? 1 : 0]);
    }

    function _hashCiphertexts(bytes32[] memory cts) internal pure returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded(euint32 val) internal {
        if (!val.isInitialized()) revert NotInitialized();
    }

    function _initIfNeeded(ebool val) internal {
        if (!val.isInitialized()) revert NotInitialized();
    }
}