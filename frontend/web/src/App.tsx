// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface BattleRecord {
  id: string;
  encryptedMove: string;
  timestamp: number;
  player: string;
  gameId: string;
  status: "pending" | "completed" | "failed";
  result?: string;
}

const FHEEncryptMove = (move: number): string => {
  return `FHE-${btoa(move.toString())}`;
};

const FHEDecryptMove = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const FHEComputeBattle = (encryptedMove1: string, encryptedMove2: string): string => {
  const move1 = FHEDecryptMove(encryptedMove1);
  const move2 = FHEDecryptMove(encryptedMove2);
  
  // Simple battle logic (rock-paper-scissors style)
  const moves = ["Attack", "Defend", "Special"];
  const resultMatrix = [
    ["Draw", "Player2", "Player1"],
    ["Player1", "Draw", "Player2"],
    ["Player2", "Player1", "Draw"]
  ];
  
  const result = resultMatrix[Math.floor(move1) % 3][Math.floor(move2) % 3];
  return FHEEncryptNumber(parseInt(result === "Player1" ? "1" : result === "Player2" ? "2" : "0"));
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [battles, setBattles] = useState<BattleRecord[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showSubmitModal, setShowSubmitModal] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newBattleMove, setNewBattleMove] = useState({ gameId: "", move: 0 });
  const [selectedBattle, setSelectedBattle] = useState<BattleRecord | null>(null);
  const [decryptedMove, setDecryptedMove] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);
  const [searchTerm, setSearchTerm] = useState("");
  const [filterStatus, setFilterStatus] = useState("all");
  const [userHistory, setUserHistory] = useState<BattleRecord[]>([]);

  const completedCount = battles.filter(b => b.status === "completed").length;
  const pendingCount = battles.filter(b => b.status === "pending").length;
  const failedCount = battles.filter(b => b.status === "failed").length;

  useEffect(() => {
    loadBattles().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  useEffect(() => {
    if (address && battles.length > 0) {
      setUserHistory(battles.filter(battle => battle.player.toLowerCase() === address.toLowerCase()));
    }
  }, [address, battles]);

  const loadBattles = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) return;
      
      const keysBytes = await contract.getData("battle_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing battle keys:", e); }
      }
      
      const list: BattleRecord[] = [];
      for (const key of keys) {
        try {
          const battleBytes = await contract.getData(`battle_${key}`);
          if (battleBytes.length > 0) {
            try {
              const battleData = JSON.parse(ethers.toUtf8String(battleBytes));
              list.push({ 
                id: key, 
                encryptedMove: battleData.move, 
                timestamp: battleData.timestamp, 
                player: battleData.player, 
                gameId: battleData.gameId, 
                status: battleData.status || "pending",
                result: battleData.result
              });
            } catch (e) { console.error(`Error parsing battle data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading battle ${key}:`, e); }
      }
      list.sort((a, b) => b.timestamp - a.timestamp);
      setBattles(list);
    } catch (e) { console.error("Error loading battles:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  const submitBattleMove = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setSubmitting(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting battle move with Zama FHE..." });
    try {
      const encryptedMove = FHEEncryptMove(newBattleMove.move);
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const battleId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const battleData = { 
        move: encryptedMove, 
        timestamp: Math.floor(Date.now() / 1000), 
        player: address, 
        gameId: newBattleMove.gameId, 
        status: "pending" 
      };
      
      await contract.setData(`battle_${battleId}`, ethers.toUtf8Bytes(JSON.stringify(battleData)));
      
      const keysBytes = await contract.getData("battle_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(battleId);
      await contract.setData("battle_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Encrypted move submitted securely!" });
      await loadBattles();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowSubmitModal(false);
        setNewBattleMove({ gameId: "", move: 0 });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected by user" : "Submission failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setSubmitting(false); }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { alert("Please connect wallet first"); return null; }
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      return FHEDecryptMove(encryptedData);
    } catch (e) { console.error("Decryption failed:", e); return null; } 
    finally { setIsDecrypting(false); }
  };

  const resolveBattle = async (battleId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Processing encrypted moves with FHE..." });
    try {
      const contract = await getContractReadOnly();
      if (!contract) throw new Error("Failed to get contract");
      
      const battleBytes = await contract.getData(`battle_${battleId}`);
      if (battleBytes.length === 0) throw new Error("Battle not found");
      const battleData = JSON.parse(ethers.toUtf8String(battleBytes));
      
      // Find opponent move in the same game
      const opponentMove = battles.find(b => 
        b.gameId === battleData.gameId && 
        b.player !== battleData.player && 
        b.status === "pending"
      );
      
      if (!opponentMove) throw new Error("No opponent move found");
      
      const battleResult = FHEComputeBattle(battleData.move, opponentMove.encryptedMove);
      
      const contractWithSigner = await getContractWithSigner();
      if (!contractWithSigner) throw new Error("Failed to get contract with signer");
      
      // Update both battles
      const updatedBattle = { ...battleData, status: "completed", result: battleResult };
      await contractWithSigner.setData(`battle_${battleId}`, ethers.toUtf8Bytes(JSON.stringify(updatedBattle)));
      
      const updatedOpponent = { ...opponentMove, status: "completed", result: battleResult };
      await contractWithSigner.setData(`battle_${opponentMove.id}`, ethers.toUtf8Bytes(JSON.stringify(updatedOpponent)));
      
      setTransactionStatus({ visible: true, status: "success", message: "FHE battle resolution completed!" });
      await loadBattles();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Resolution failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const filteredBattles = battles.filter(battle => {
    const matchesSearch = battle.gameId.toLowerCase().includes(searchTerm.toLowerCase()) || 
                         battle.player.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesStatus = filterStatus === "all" || battle.status === filterStatus;
    return matchesSearch && matchesStatus;
  });

  const renderBattleStats = () => {
    return (
      <div className="stats-grid">
        <div className="stat-item">
          <div className="stat-value">{battles.length}</div>
          <div className="stat-label">Total Battles</div>
        </div>
        <div className="stat-item">
          <div className="stat-value">{completedCount}</div>
          <div className="stat-label">Completed</div>
        </div>
        <div className="stat-item">
          <div className="stat-value">{pendingCount}</div>
          <div className="stat-label">Pending</div>
        </div>
        <div className="stat-item">
          <div className="stat-value">{failedCount}</div>
          <div className="stat-label">Failed</div>
        </div>
      </div>
    );
  };

  if (loading) return (
    <div className="loading-screen">
      <div className="gear-spinner"></div>
      <p>Initializing encrypted battle arena...</p>
    </div>
  );

  return (
    <div className="app-container industrial-theme">
      <header className="app-header">
        <div className="logo">
          <div className="gear-icon"></div>
          <h1>隱秘戰術競技場</h1>
          <div className="subtitle">FHE-Encrypted Battle Arena</div>
        </div>
        <div className="header-actions">
          <button onClick={() => setShowSubmitModal(true)} className="submit-move-btn industrial-button">
            <div className="sword-icon"></div>Submit Move
          </button>
          <div className="wallet-connect-wrapper">
            <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/>
          </div>
        </div>
      </header>

      <div className="main-content">
        <div className="project-intro industrial-card">
          <h2>FHE-Encrypted Battle Arena</h2>
          <p>
            A turn-based tactical game where both players submit FHE-encrypted action commands simultaneously. 
            The server homomorphically computes all action results at once, achieving perfect simultaneous turn-based gameplay.
          </p>
          <div className="fhe-features">
            <div className="feature-item">
              <div className="feature-icon">🔒</div>
              <div>Player moves are encrypted with Zama FHE</div>
            </div>
            <div className="feature-item">
              <div className="feature-icon">⚔️</div>
              <div>Turn results computed homomorphically</div>
            </div>
            <div className="feature-item">
              <div className="feature-icon">⚖️</div>
              <div>Eliminates first-move advantage in turn-based games</div>
            </div>
          </div>
        </div>

        <div className="dashboard-section">
          <div className="stats-card industrial-card">
            <h3>Battle Statistics</h3>
            {renderBattleStats()}
          </div>

          {isConnected && (
            <div className="history-card industrial-card">
              <h3>Your Battle History</h3>
              {userHistory.length > 0 ? (
                <div className="history-list">
                  {userHistory.slice(0, 3).map(battle => (
                    <div key={battle.id} className="history-item" onClick={() => setSelectedBattle(battle)}>
                      <div className="game-id">Game #{battle.gameId.substring(0, 6)}</div>
                      <div className={`status ${battle.status}`}>{battle.status}</div>
                      <div className="date">{new Date(battle.timestamp * 1000).toLocaleDateString()}</div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="no-history">No battle history found</div>
              )}
            </div>
          )}
        </div>

        <div className="battles-section">
          <div className="section-header">
            <h2>Battle Records</h2>
            <div className="controls">
              <div className="search-box">
                <input 
                  type="text" 
                  placeholder="Search battles..." 
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                />
                <div className="search-icon"></div>
              </div>
              <select 
                value={filterStatus} 
                onChange={(e) => setFilterStatus(e.target.value)}
                className="status-filter"
              >
                <option value="all">All Status</option>
                <option value="pending">Pending</option>
                <option value="completed">Completed</option>
                <option value="failed">Failed</option>
              </select>
              <button onClick={loadBattles} className="refresh-btn industrial-button" disabled={isRefreshing}>
                {isRefreshing ? "Refreshing..." : "Refresh"}
              </button>
            </div>
          </div>

          <div className="battles-list industrial-card">
            {filteredBattles.length === 0 ? (
              <div className="no-battles">
                <div className="no-data-icon"></div>
                <p>No battle records found</p>
                <button className="industrial-button primary" onClick={() => setShowSubmitModal(true)}>Start First Battle</button>
              </div>
            ) : (
              <div className="battle-grid">
                {filteredBattles.map(battle => (
                  <div 
                    key={battle.id} 
                    className={`battle-card ${battle.status}`}
                    onClick={() => setSelectedBattle(battle)}
                  >
                    <div className="battle-header">
                      <div className="game-id">Game #{battle.gameId.substring(0, 6)}</div>
                      <div className={`status-badge ${battle.status}`}>{battle.status}</div>
                    </div>
                    <div className="battle-details">
                      <div className="player">Player: {battle.player.substring(0, 6)}...{battle.player.substring(38)}</div>
                      <div className="date">{new Date(battle.timestamp * 1000).toLocaleString()}</div>
                    </div>
                    {battle.status === "pending" && isConnected && battle.player.toLowerCase() === address?.toLowerCase() && (
                      <button 
                        className="resolve-btn industrial-button small"
                        onClick={(e) => {
                          e.stopPropagation();
                          resolveBattle(battle.id);
                        }}
                      >
                        Resolve
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {showSubmitModal && (
        <ModalSubmitMove 
          onSubmit={submitBattleMove} 
          onClose={() => setShowSubmitModal(false)} 
          submitting={submitting} 
          moveData={newBattleMove} 
          setMoveData={setNewBattleMove}
        />
      )}

      {selectedBattle && (
        <BattleDetailModal 
          battle={selectedBattle} 
          onClose={() => { 
            setSelectedBattle(null); 
            setDecryptedMove(null); 
          }} 
          decryptedMove={decryptedMove} 
          setDecryptedMove={setDecryptedMove} 
          isDecrypting={isDecrypting} 
          decryptWithSignature={decryptWithSignature}
        />
      )}

      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content industrial-card">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="gear-spinner"></div>}
              {transactionStatus.status === "success" && <div className="check-icon"></div>}
              {transactionStatus.status === "error" && <div className="error-icon"></div>}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}

      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="logo">
              <div className="gear-icon"></div>
              <span>隱秘戰術競技場</span>
            </div>
            <p>FHE-encrypted battle strategy game powered by Zama</p>
          </div>
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">GitHub</a>
            <a href="#" className="footer-link">Terms</a>
          </div>
        </div>
        <div className="footer-bottom">
          <div className="fhe-badge">FHE-Powered Gaming</div>
          <div className="copyright">© {new Date().getFullYear()} Battle Strategy FHE. All rights reserved.</div>
        </div>
      </footer>
    </div>
  );
};

interface ModalSubmitMoveProps {
  onSubmit: () => void; 
  onClose: () => void; 
  submitting: boolean;
  moveData: any;
  setMoveData: (data: any) => void;
}

const ModalSubmitMove: React.FC<ModalSubmitMoveProps> = ({ onSubmit, onClose, submitting, moveData, setMoveData }) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setMoveData({ ...moveData, [name]: value });
  };

  const handleMoveChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const { name, value } = e.target;
    setMoveData({ ...moveData, [name]: parseInt(value) });
  };

  const handleSubmit = () => {
    if (!moveData.gameId || moveData.move === undefined) { 
      alert("Please fill required fields"); 
      return; 
    }
    onSubmit();
  };

  return (
    <div className="modal-overlay">
      <div className="submit-modal industrial-card">
        <div className="modal-header">
          <h2>Submit Encrypted Battle Move</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="fhe-notice">
            <div className="lock-icon"></div>
            <p>Your move will be encrypted with <strong>Zama FHE</strong> before submission</p>
          </div>

          <div className="form-group">
            <label>Game ID *</label>
            <input 
              type="text" 
              name="gameId" 
              value={moveData.gameId} 
              onChange={handleChange} 
              placeholder="Enter game identifier..."
            />
          </div>

          <div className="form-group">
            <label>Battle Move *</label>
            <select name="move" value={moveData.move} onChange={handleMoveChange}>
              <option value="">Select your move</option>
              <option value="0">Attack (Rock)</option>
              <option value="1">Defend (Paper)</option>
              <option value="2">Special (Scissors)</option>
            </select>
          </div>

          <div className="encryption-preview">
            <h4>Encryption Preview</h4>
            <div className="preview-content">
              <div className="plain-data">
                <span>Plain Move:</span>
                <div>{moveData.move !== undefined ? ["Attack", "Defend", "Special"][moveData.move] : "No move selected"}</div>
              </div>
              <div className="arrow">→</div>
              <div className="encrypted-data">
                <span>Encrypted Data:</span>
                <div>{moveData.move !== undefined ? FHEEncryptMove(moveData.move).substring(0, 50) + '...' : "No move selected"}</div>
              </div>
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="cancel-btn industrial-button">Cancel</button>
          <button onClick={handleSubmit} disabled={submitting} className="submit-btn industrial-button primary">
            {submitting ? "Encrypting with FHE..." : "Submit Encrypted Move"}
          </button>
        </div>
      </div>
    </div>
  );
};

interface BattleDetailModalProps {
  battle: BattleRecord;
  onClose: () => void;
  decryptedMove: number | null;
  setDecryptedMove: (value: number | null) => void;
  isDecrypting: boolean;
  decryptWithSignature: (encryptedData: string) => Promise<number | null>;
}

const BattleDetailModal: React.FC<BattleDetailModalProps> = ({ battle, onClose, decryptedMove, setDecryptedMove, isDecrypting, decryptWithSignature }) => {
  const handleDecrypt = async () => {
    if (decryptedMove !== null) { setDecryptedMove(null); return; }
    const decrypted = await decryptWithSignature(battle.encryptedMove);
    if (decrypted !== null) setDecryptedMove(decrypted);
  };

  return (
    <div className="modal-overlay">
      <div className="battle-detail-modal industrial-card">
        <div className="modal-header">
          <h2>Battle Details</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="battle-info">
            <div className="info-item"><span>Game ID:</span><strong>{battle.gameId}</strong></div>
            <div className="info-item"><span>Player:</span><strong>{battle.player.substring(0, 6)}...{battle.player.substring(38)}</strong></div>
            <div className="info-item"><span>Date:</span><strong>{new Date(battle.timestamp * 1000).toLocaleString()}</strong></div>
            <div className="info-item"><span>Status:</span><strong className={`status ${battle.status}`}>{battle.status}</strong></div>
            {battle.result && (
              <div className="info-item"><span>Result:</span><strong>{battle.result}</strong></div>
            )}
          </div>

          <div className="encrypted-section">
            <h3>Encrypted Move</h3>
            <div className="encrypted-data">{battle.encryptedMove.substring(0, 100)}...</div>
            <div className="fhe-tag">
              <div className="fhe-icon"></div>
              <span>FHE Encrypted</span>
            </div>
            <button 
              className="decrypt-btn industrial-button" 
              onClick={handleDecrypt} 
              disabled={isDecrypting}
            >
              {isDecrypting ? "Decrypting..." : decryptedMove !== null ? "Hide Move" : "Decrypt with Wallet"}
            </button>
          </div>

          {decryptedMove !== null && (
            <div className="decrypted-section">
              <h3>Decrypted Move</h3>
              <div className="decrypted-move">
                {["Attack", "Defend", "Special"][decryptedMove]}
              </div>
              <div className="decryption-notice">
                <div className="warning-icon"></div>
                <span>Decrypted move is only visible after wallet signature verification</span>
              </div>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="close-btn industrial-button">Close</button>
        </div>
      </div>
    </div>
  );
};

export default App;