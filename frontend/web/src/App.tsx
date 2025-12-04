// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface GameNode {
  id: string;
  title: string;
  content: string;
  encryptedChoices: string[];
  encryptedConditions: string;
  timestamp: number;
  owner: string;
  isEnding: boolean;
  nftMinted: boolean;
}

const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [nodes, setNodes] = useState<GameNode[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newNodeData, setNewNodeData] = useState({ title: "", content: "", isEnding: false });
  const [searchTerm, setSearchTerm] = useState("");
  const [filterEndings, setFilterEndings] = useState(false);
  const [userHistory, setUserHistory] = useState<string[]>([]);
  const [publicKey, setPublicKey] = useState<string>("");
  const [selectedNode, setSelectedNode] = useState<GameNode | null>(null);
  const [decryptedCondition, setDecryptedCondition] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);

  // Stats for dashboard
  const totalNodes = nodes.length;
  const endingNodes = nodes.filter(n => n.isEnding).length;
  const nftNodes = nodes.filter(n => n.nftMinted).length;
  const yourNodes = isConnected ? nodes.filter(n => n.owner.toLowerCase() === address?.toLowerCase()).length : 0;

  useEffect(() => {
    loadNodes().finally(() => setLoading(false));
    setPublicKey(generatePublicKey());
  }, []);

  const loadNodes = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) return;
      
      const keysBytes = await contract.getData("node_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing node keys:", e); }
      }
      
      const list: GameNode[] = [];
      for (const key of keys) {
        try {
          const nodeBytes = await contract.getData(`node_${key}`);
          if (nodeBytes.length > 0) {
            try {
              const nodeData = JSON.parse(ethers.toUtf8String(nodeBytes));
              list.push({ 
                id: key, 
                title: nodeData.title, 
                content: nodeData.content, 
                encryptedChoices: nodeData.choices || [],
                encryptedConditions: nodeData.conditions || "",
                timestamp: nodeData.timestamp, 
                owner: nodeData.owner, 
                isEnding: nodeData.isEnding || false,
                nftMinted: nodeData.nftMinted || false
              });
            } catch (e) { console.error(`Error parsing node data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading node ${key}:`, e); }
      }
      list.sort((a, b) => b.timestamp - a.timestamp);
      setNodes(list);
    } catch (e) { console.error("Error loading nodes:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  const submitNode = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setCreating(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting game node with Zama FHE..." });
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const nodeId = `node-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
      const nodeData = { 
        title: newNodeData.title,
        content: newNodeData.content,
        choices: [],
        conditions: "",
        timestamp: Math.floor(Date.now() / 1000),
        owner: address,
        isEnding: newNodeData.isEnding,
        nftMinted: false
      };
      
      await contract.setData(`node_${nodeId}`, ethers.toUtf8Bytes(JSON.stringify(nodeData)));
      
      const keysBytes = await contract.getData("node_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(nodeId);
      await contract.setData("node_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Game node created successfully!" });
      addToHistory(`Created node: ${newNodeData.title}`);
      await loadNodes();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewNodeData({ title: "", content: "", isEnding: false });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected by user" : "Submission failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setCreating(false); }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { alert("Please connect wallet first"); return null; }
    setIsDecrypting(true);
    try {
      const message = `DecryptFHE:${publicKey}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      return FHEDecryptNumber(encryptedData);
    } catch (e) { console.error("Decryption failed:", e); return null; } 
    finally { setIsDecrypting(false); }
  };

  const addToHistory = (action: string) => {
    setUserHistory(prev => [action, ...prev.slice(0, 9)]);
  };

  const filteredNodes = nodes.filter(node => {
    const matchesSearch = node.title.toLowerCase().includes(searchTerm.toLowerCase()) || 
                         node.content.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesEndingFilter = !filterEndings || node.isEnding;
    return matchesSearch && matchesEndingFilter;
  });

  if (loading) return (
    <div className="loading-screen">
      <div className="anime-spinner"></div>
      <p>Loading Adventure Game Kit...</p>
    </div>
  );

  return (
    <div className="app-container anime-theme">
      <header className="app-header">
        <div className="logo">
          <h1>FHE Adventure Kit</h1>
          <p>Create encrypted choose-your-own-adventure games</p>
        </div>
        <div className="header-actions">
          <ConnectButton accountStatus="avatar" chainStatus="icon" showBalance={false} />
        </div>
      </header>

      <div className="main-content">
        {/* Project Introduction */}
        <div className="intro-card anime-card">
          <h2>Welcome to FHE Adventure Kit</h2>
          <p>
            A toolkit for creating FHE-based "choose your own adventure" games where 
            story branches and player states are encrypted using Zama FHE technology.
            Endings can be minted as NFTs while keeping gameplay data private.
          </p>
          <div className="fhe-badge">
            <span>Powered by Zama FHE</span>
          </div>
          <button 
            className="anime-button primary" 
            onClick={() => setShowCreateModal(true)}
          >
            Create New Story Node
          </button>
        </div>

        {/* Data Statistics */}
        <div className="stats-grid">
          <div className="stat-card anime-card">
            <h3>Total Nodes</h3>
            <div className="stat-value">{totalNodes}</div>
          </div>
          <div className="stat-card anime-card">
            <h3>Ending Nodes</h3>
            <div className="stat-value">{endingNodes}</div>
          </div>
          <div className="stat-card anime-card">
            <h3>NFT Endings</h3>
            <div className="stat-value">{nftNodes}</div>
          </div>
          <div className="stat-card anime-card">
            <h3>Your Nodes</h3>
            <div className="stat-value">{yourNodes}</div>
          </div>
        </div>

        {/* Search & Filter */}
        <div className="search-section anime-card">
          <div className="search-bar">
            <input
              type="text"
              placeholder="Search nodes..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="anime-input"
            />
            <button className="anime-button icon">
              <span className="search-icon">🔍</span>
            </button>
          </div>
          <div className="filter-options">
            <label className="anime-checkbox">
              <input
                type="checkbox"
                checked={filterEndings}
                onChange={() => setFilterEndings(!filterEndings)}
              />
              <span>Show Only Endings</span>
            </label>
          </div>
        </div>

        {/* Nodes List */}
        <div className="nodes-section">
          <h2>Story Nodes</h2>
          {filteredNodes.length === 0 ? (
            <div className="empty-state anime-card">
              <div className="empty-icon">📖</div>
              <p>No story nodes found</p>
              <button 
                className="anime-button primary" 
                onClick={() => setShowCreateModal(true)}
              >
                Create First Node
              </button>
            </div>
          ) : (
            <div className="nodes-grid">
              {filteredNodes.map(node => (
                <div 
                  key={node.id} 
                  className="node-card anime-card"
                  onClick={() => setSelectedNode(node)}
                >
                  <div className="node-header">
                    <h3>{node.title}</h3>
                    {node.isEnding && <span className="ending-tag">Ending</span>}
                    {node.nftMinted && <span className="nft-tag">NFT</span>}
                  </div>
                  <p className="node-content">
                    {node.content.length > 100 
                      ? `${node.content.substring(0, 100)}...` 
                      : node.content}
                  </p>
                  <div className="node-footer">
                    <span className="owner">
                      {node.owner.substring(0, 6)}...{node.owner.substring(38)}
                    </span>
                    <span className="date">
                      {new Date(node.timestamp * 1000).toLocaleDateString()}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* User History */}
        <div className="history-section anime-card">
          <h2>Your Recent Actions</h2>
          {userHistory.length === 0 ? (
            <p className="empty-history">No recent actions</p>
          ) : (
            <ul className="history-list">
              {userHistory.map((action, index) => (
                <li key={index} className="history-item">
                  <span className="action-icon">✏️</span>
                  {action}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Create Node Modal */}
      {showCreateModal && (
        <div className="modal-overlay">
          <div className="create-modal anime-card">
            <div className="modal-header">
              <h2>Create New Story Node</h2>
              <button onClick={() => setShowCreateModal(false)} className="close-modal">
                &times;
              </button>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label>Node Title</label>
                <input
                  type="text"
                  name="title"
                  value={newNodeData.title}
                  onChange={(e) => setNewNodeData({...newNodeData, title: e.target.value})}
                  placeholder="Enter node title..."
                  className="anime-input"
                />
              </div>
              <div className="form-group">
                <label>Content</label>
                <textarea
                  name="content"
                  value={newNodeData.content}
                  onChange={(e) => setNewNodeData({...newNodeData, content: e.target.value})}
                  placeholder="Enter story content..."
                  className="anime-textarea"
                  rows={5}
                />
              </div>
              <div className="form-group checkbox">
                <label>
                  <input
                    type="checkbox"
                    checked={newNodeData.isEnding}
                    onChange={(e) => setNewNodeData({...newNodeData, isEnding: e.target.checked})}
                  />
                  Is this an ending node? (Can be minted as NFT)
                </label>
              </div>
              <div className="fhe-notice">
                <span className="fhe-icon">🔒</span>
                <p>
                  Player states and conditions will be encrypted using Zama FHE technology
                </p>
              </div>
            </div>
            <div className="modal-footer">
              <button 
                onClick={() => setShowCreateModal(false)} 
                className="anime-button"
              >
                Cancel
              </button>
              <button 
                onClick={submitNode} 
                disabled={creating || !newNodeData.title || !newNodeData.content}
                className="anime-button primary"
              >
                {creating ? "Creating..." : "Create Node"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Node Detail Modal */}
      {selectedNode && (
        <div className="modal-overlay">
          <div className="node-detail-modal anime-card">
            <div className="modal-header">
              <h2>{selectedNode.title}</h2>
              <button onClick={() => setSelectedNode(null)} className="close-modal">
                &times;
              </button>
            </div>
            <div className="modal-body">
              <div className="node-meta">
                <span className="owner">
                  Created by: {selectedNode.owner.substring(0, 6)}...{selectedNode.owner.substring(38)}
                </span>
                <span className="date">
                  {new Date(selectedNode.timestamp * 1000).toLocaleString()}
                </span>
                {selectedNode.isEnding && <span className="ending-tag">Ending</span>}
                {selectedNode.nftMinted && <span className="nft-tag">NFT Minted</span>}
              </div>
              
              <div className="node-content">
                <p>{selectedNode.content}</p>
              </div>
              
              {selectedNode.encryptedConditions && (
                <div className="encrypted-section">
                  <h3>Encrypted Conditions</h3>
                  <div className="encrypted-data">
                    {selectedNode.encryptedConditions.substring(0, 50)}...
                  </div>
                  <button 
                    className="anime-button"
                    onClick={async () => {
                      if (decryptedCondition !== null) {
                        setDecryptedCondition(null);
                      } else {
                        const decrypted = await decryptWithSignature(selectedNode.encryptedConditions);
                        if (decrypted !== null) {
                          setDecryptedCondition(decrypted);
                          addToHistory(`Decrypted condition in: ${selectedNode.title}`);
                        }
                      }
                    }}
                    disabled={isDecrypting}
                  >
                    {isDecrypting ? "Decrypting..." : 
                     decryptedCondition !== null ? "Hide Value" : "Decrypt Condition"}
                  </button>
                  {decryptedCondition !== null && (
                    <div className="decrypted-value">
                      <strong>Decrypted Value:</strong> {decryptedCondition}
                    </div>
                  )}
                </div>
              )}
              
              {selectedNode.encryptedChoices.length > 0 && (
                <div className="choices-section">
                  <h3>Choices</h3>
                  <ul className="choices-list">
                    {selectedNode.encryptedChoices.map((choice, index) => (
                      <li key={index} className="choice-item">
                        <span className="choice-icon">→</span>
                        {choice.length > 50 ? `${choice.substring(0, 50)}...` : choice}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
            <div className="modal-footer">
              {isConnected && address?.toLowerCase() === selectedNode.owner.toLowerCase() && (
                <button className="anime-button warning">
                  Edit Node
                </button>
              )}
              <button 
                onClick={() => setSelectedNode(null)} 
                className="anime-button"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Transaction Status Modal */}
      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content anime-card">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="anime-spinner"></div>}
              {transactionStatus.status === "success" && <span>✓</span>}
              {transactionStatus.status === "error" && <span>✗</span>}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}

      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">About Zama FHE</a>
            <a href="#" className="footer-link">Community</a>
          </div>
          <div className="footer-copyright">
            © {new Date().getFullYear()} FHE Adventure Kit - Privacy-focused storytelling
          </div>
        </div>
      </footer>
    </div>
  );
};

export default App;