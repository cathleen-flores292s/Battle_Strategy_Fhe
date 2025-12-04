pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract BattleStrategyFhe is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }

    struct PlayerSubmission {
        euint32 encryptedMove;
        euint32 encryptedTarget;
        bool submitted;
    }

    struct BattleResult {
        euint32 player1Outcome;
        euint32 player2Outcome;
        euint32 winner; // 0 for draw, 1 for P1, 2 for P2
    }

    struct GameBatch {
        uint256 id;
        address player1;
        address player2;
        bool isOpen;
        bool isResolved;
        BattleResult encryptedResult;
    }

    mapping(uint256 => DecryptionContext) public decryptionContexts;
    mapping(address => bool) public isProvider;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;
    mapping(uint256 => GameBatch) public gameBatches;
    mapping(uint256 => mapping(address => PlayerSubmission)) public batchSubmissions;

    address public owner;
    bool public paused;
    uint256 public cooldownSeconds = 30;
    uint256 public currentBatchId = 0;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event ContractPaused(address indexed account);
    event ContractUnpaused(address indexed account);
    event CooldownSecondsUpdated(uint256 oldCooldown, uint256 newCooldown);
    event BatchOpened(uint256 indexed batchId, address indexed player1, address indexed player2);
    event BatchClosed(uint256 indexed batchId);
    event StrategySubmitted(uint256 indexed batchId, address indexed player);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, uint8 winner, uint32 player1Outcome, uint32 player2Outcome);

    error NotOwner();
    error NotProvider();
    error Paused();
    error CooldownActive();
    error BatchClosedOrFull();
    error AlreadySubmitted();
    error InvalidBatch();
    error ReplayAttempt();
    error StateMismatch();
    error InvalidProof();

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

    modifier respectCooldown(address user, mapping(address => uint256) storage cooldownMapping) {
        if (block.timestamp < cooldownMapping[user] + cooldownSeconds) {
            revert CooldownActive();
        }
        cooldownMapping[user] = block.timestamp;
        _;
    }

    constructor() {
        owner = msg.sender;
        isProvider[msg.sender] = true;
        emit ProviderAdded(msg.sender);
        emit OwnershipTransferred(address(0), msg.sender);
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
        emit ContractPaused(msg.sender);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit ContractUnpaused(msg.sender);
    }

    function setCooldownSeconds(uint256 newCooldown) external onlyOwner {
        require(newCooldown > 0, "Cooldown must be positive");
        uint256 oldCooldown = cooldownSeconds;
        cooldownSeconds = newCooldown;
        emit CooldownSecondsUpdated(oldCooldown, newCooldown);
    }

    function openBatch(address player1, address player2) external onlyProvider whenNotPaused {
        if (player1 == address(0) || player2 == address(0) || player1 == player2) revert InvalidBatch();
        uint256 batchId = ++currentBatchId;
        gameBatches[batchId] = GameBatch({
            id : batchId,
            player1 : player1,
            player2 : player2,
            isOpen : true,
            isResolved : false,
            encryptedResult : BattleResult({
                player1Outcome : euint32(0),
                player2Outcome : euint32(0),
                winner : euint32(0)
            })
        });
        emit BatchOpened(batchId, player1, player2);
    }

    function closeBatch(uint256 batchId) external onlyProvider whenNotPaused {
        GameBatch storage batch = gameBatches[batchId];
        if (batch.id == 0 || !batch.isOpen) revert InvalidBatch();
        batch.isOpen = false;
        emit BatchClosed(batchId);
    }

    function _initIfNeeded(euint32 cipher) internal {
        if (!FHE.isInitialized(cipher)) {
            FHE.asEuint32(0); // Initialize the FHE context if not already done
        }
    }

    function submitStrategy(
        uint256 batchId,
        euint32 encryptedMove,
        euint32 encryptedTarget
    ) external whenNotPaused respectCooldown(msg.sender, lastSubmissionTime) {
        GameBatch storage batch = gameBatches[batchId];
        if (batch.id == 0 || !batch.isOpen) revert InvalidBatch();

        if (msg.sender != batch.player1 && msg.sender != batch.player2) revert NotProvider();
        if (batchSubmissions[batchId][msg.sender].submitted) revert AlreadySubmitted();

        _initIfNeeded(encryptedMove);
        _initIfNeeded(encryptedTarget);

        batchSubmissions[batchId][msg.sender] = PlayerSubmission({
            encryptedMove : encryptedMove,
            encryptedTarget : encryptedTarget,
            submitted : true
        });

        emit StrategySubmitted(batchId, msg.sender);
    }

    function _hashCiphertexts(bytes32[] memory cts) internal pure returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _resolveBatch(uint256 batchId) internal {
        GameBatch storage batch = gameBatches[batchId];
        if (batch.id == 0 || batch.isResolved) revert InvalidBatch();

        PlayerSubmission storage sub1 = batchSubmissions[batchId][batch.player1];
        PlayerSubmission storage sub2 = batchSubmissions[batchId][batch.player2];

        if (!sub1.submitted || !sub2.submitted) revert BatchClosedOrFull();

        euint32 p1Move = sub1.encryptedMove;
        euint32 p1Target = sub1.encryptedTarget;
        euint32 p2Move = sub2.encryptedMove;
        euint32 p2Target = sub2.encryptedTarget;

        euint32 p1Outcome = _calculatePlayerOutcome(p1Move, p2Move, p1Target, p2Target);
        euint32 p2Outcome = _calculatePlayerOutcome(p2Move, p1Move, p2Target, p1Target);

        ebool p1Wins = p1Outcome.ge(p2Outcome).and(p1Outcome.neq(p2Outcome));
        ebool p2Wins = p2Outcome.ge(p1Outcome).and(p1Outcome.neq(p2Outcome));

        euint32 winner = euint32(0); // Default to draw
        winner = winner.select(p1Wins, euint32(1)); // If P1 wins, set to 1
        winner = winner.select(p2Wins, euint32(2)); // If P2 wins, set to 2

        batch.encryptedResult = BattleResult({
            player1Outcome : p1Outcome,
            player2Outcome : p2Outcome,
            winner : winner
        });
        batch.isResolved = true;
    }

    function _calculatePlayerOutcome(
        euint32 myMove,
        euint32 theirMove,
        euint32 myTarget,
        euint32 theirTarget
    ) internal pure returns (euint32) {
        ebool hitTarget = myTarget.eq(theirMove);
        euint32 baseDamage = euint32(10); // Example base damage
        euint32 damage = baseDamage.mul(hitTarget.toEuint32());
        euint32 outcome = damage.sub(theirMove); // Simplified outcome: damage dealt minus opponent's move value
        return outcome;
    }

    function requestBatchResolution(uint256 batchId) external onlyProvider whenNotPaused respectCooldown(msg.sender, lastDecryptionRequestTime) {
        GameBatch storage batch = gameBatches[batchId];
        if (batch.id == 0 || !batch.isResolved) revert InvalidBatch();

        _resolveBatch(batchId); // Ensure encrypted results are computed

        BattleResult storage result = batch.encryptedResult;
        bytes32[] memory cts = new bytes32[](3);
        cts[0] = FHE.toBytes32(result.player1Outcome);
        cts[1] = FHE.toBytes32(result.player2Outcome);
        cts[2] = FHE.toBytes32(result.winner);

        bytes32 stateHash = _hashCiphertexts(cts);
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);

        decryptionContexts[requestId] = DecryptionContext({
        batchId : batchId,
        stateHash : stateHash,
        processed : false
        });

        emit DecryptionRequested(requestId, batchId);
    }

    function myCallback(uint256 requestId, bytes memory cleartexts, bytes memory proof) public {
        if (decryptionContexts[requestId].processed) revert ReplayAttempt();

        DecryptionContext storage ctx = decryptionContexts[requestId];
        GameBatch storage batch = gameBatches[ctx.batchId];

        // Rebuild ciphertexts for state verification
        BattleResult storage result = batch.encryptedResult;
        bytes32[] memory cts = new bytes32[](3);
        cts[0] = FHE.toBytes32(result.player1Outcome);
        cts[1] = FHE.toBytes32(result.player2Outcome);
        cts[2] = FHE.toBytes32(result.winner);

        bytes32 currentHash = _hashCiphertexts(cts);
        if (currentHash != ctx.stateHash) revert StateMismatch();

        if (!FHE.checkSignatures(requestId, cleartexts, proof)) revert InvalidProof();

        // Decode cleartexts in the same order
        uint32 p1OutcomeCleartext = abi.decode(cleartexts[0:32], (uint32));
        uint32 p2OutcomeCleartext = abi.decode(cleartexts[32:64], (uint32));
        uint32 winnerCleartext = abi.decode(cleartexts[64:96], (uint32));

        ctx.processed = true;

        emit DecryptionCompleted(requestId, ctx.batchId, uint8(winnerCleartext), p1OutcomeCleartext, p2OutcomeCleartext);
        // Further game logic can be triggered here using the decrypted values
    }
}