import React, { useEffect, useRef, useState } from 'react'
import io from "socket.io-client";
import { Badge, IconButton, TextField } from '@mui/material';
import { Button } from '@mui/material';
import VideocamIcon from '@mui/icons-material/Videocam';
import VideocamOffIcon from '@mui/icons-material/VideocamOff'
import styles from "../styles/videoComponent.module.css";
import CallEndIcon from '@mui/icons-material/CallEnd'
import MicIcon from '@mui/icons-material/Mic'
import MicOffIcon from '@mui/icons-material/MicOff'
import ScreenShareIcon from '@mui/icons-material/ScreenShare';
import StopScreenShareIcon from '@mui/icons-material/StopScreenShare'
import ChatIcon from '@mui/icons-material/Chat'
import server from '../enviroment';
import { useNavigate } from 'react-router-dom';
const server_url = server;
//import { Navigate } from 'react-router-dom';
//import { useNavigate } from 'react-router-dom';

// Global connections map (as you had)
let connections = {};
const peerConfigConnections = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
};

export default function VideoMeetComponent() {
 const navigate = useNavigate();

  const socketRef = useRef(null);
  const socketIdRef = useRef(null);

  const localVideoref = useRef(null);

  const [videoAvailable, setVideoAvailable] = useState(true);
  const [audioAvailable, setAudioAvailable] = useState(true);

  const [video, setVideo] = useState(true);
  const [audio, setAudio] = useState(true);

  // screen sharing toggle
  const [screen, setScreen] = useState(false);
  const [showModal, setModal] = useState(true);
  const [screenAvailable, setScreenAvailable] = useState(false);

  const [messages, setMessages] = useState([]);
  const [message, setMessage] = useState("");
  const [newMessages, setNewMessages] = useState(0);

  const [askForUsername, setAskForUsername] = useState(true);
  const [username, setUsername] = useState("");

  const videoRef = useRef([]);              // mirror of videos state
  const [videos, setVideos] = useState([]); // [{socketId, stream}]
  const [names, setNames] = useState({});   // { [socketId]: username }

  // your own tile stream
  const [selfStream, setSelfStream] = useState(null);

  // keep a reference to the camera stream so we can revert after screen share
  const camStreamRef = useRef(null);
  // track the current “outgoing” stream (camera or screen mix)
  const currentOutStreamRef = useRef(null);

  // ===== Ensure your camera shows immediately =====
  useEffect(() => {
    getPermissions();
    return () => {
      try { localVideoref.current?.srcObject?.getTracks?.().forEach(t => t.stop()); } catch {}
      try { socketRef.current?.disconnect(); } catch {}
      connections = {};
    };
  }, []);

  const getPermissions = async () => {
    try {
      await navigator.mediaDevices.getUserMedia({ video: true }).then(() => setVideoAvailable(true)).catch(() => setVideoAvailable(false));
      await navigator.mediaDevices.getUserMedia({ audio: true }).then(() => setAudioAvailable(true)).catch(() => setAudioAvailable(false));
      setScreenAvailable(!!navigator.mediaDevices.getDisplayMedia);

      // get combined stream (local cam + mic)
      const userMediaStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });

      camStreamRef.current = userMediaStream;        // save camera for later
      currentOutStreamRef.current = userMediaStream; // currently sending camera
      window.localStream = userMediaStream;

      if (localVideoref.current) {
        localVideoref.current.srcObject = userMediaStream; // preview ref for toggles
      }
      setSelfStream(userMediaStream); // show your cam in the grid

      setVideo(userMediaStream.getVideoTracks()[0]?.enabled !== false);
      setAudio(userMediaStream.getAudioTracks()[0]?.enabled !== false);
    } catch (e) {
      console.log(e);
      setVideoAvailable(false);
      setAudioAvailable(false);
    }
  };

  // ===== Socket / signaling (same logic, tiny name wiring) =====
  const connectToSocketServer = () => {
    if (socketRef.current) return;
    socketRef.current = io.connect(server_url, { secure: false });

    socketRef.current.on('signal', gotMessageFromServer);

    socketRef.current.on('connect', () => {
      socketRef.current.emit('join-call', window.location.href);
      socketIdRef.current = socketRef.current.id;

      // announce my name (server should echo peer-list / peer-username)
      socketRef.current.emit('introduce', { username });

      socketRef.current.on('peer-list', (mapping) => {
        if (mapping && typeof mapping === 'object') setNames(mapping);
      });

      socketRef.current.on('peer-username', ({ socketId, username: nm }) => {
        setNames(prev => ({ ...prev, [socketId]: nm }));
      });

      socketRef.current.on('chat-message', (data, sender, socketIdSender) => {
        setMessages(prev => [...prev, { sender, data }]);
        if (!showModal && socketIdSender !== socketIdRef.current) {
          setNewMessages(prev => prev + 1);
        }
      });

      socketRef.current.on('user-left', (id) => {
        setVideos(vs => vs.filter(v => v.socketId !== id));
        videoRef.current = videoRef.current.filter(v => v.socketId !== id);
        setNames(prev => { const c = { ...prev }; delete c[id]; return c; });
      });

      socketRef.current.on('user-joined', (id, clients) => {
        clients.forEach((socketListId) => {
          const pc = new RTCPeerConnection(peerConfigConnections);
          connections[socketListId] = pc;

          pc.onicecandidate = (event) => {
            if (event.candidate) {
              socketRef.current.emit('signal', socketListId, JSON.stringify({ ice: event.candidate }));
            }
          };

          // keep your existing onaddstream (legacy but fine with your code)
          pc.onaddstream = (event) => {
            const exists = videoRef.current.find(v => v.socketId === socketListId);
            if (exists) {
              setVideos(vs => {
                const upd = vs.map(v => v.socketId === socketListId ? { ...v, stream: event.stream } : v);
                videoRef.current = upd;
                return upd;
              });
            } else {
              const newV = { socketId: socketListId, stream: event.stream, autoplay: true, playsinline: true };
              setVideos(vs => {
                const upd = [...vs, newV];
                videoRef.current = upd;
                return upd;
              });
            }
          };

          // Add the current outgoing stream (camera initially)
          if (currentOutStreamRef.current) {
            pc.addStream(currentOutStreamRef.current);
          }
        });

        // we are the new peer; send offers to others
        if (id === socketIdRef.current) {
          for (let id2 in connections) {
            if (id2 === socketIdRef.current) continue;

            try { connections[id2].addStream(currentOutStreamRef.current); } catch {}

            connections[id2].createOffer().then((description) => {
              connections[id2].setLocalDescription(description)
                .then(() => {
                  socketRef.current.emit('signal', id2, JSON.stringify({ sdp: connections[id2].localDescription }));
                })
                .catch(console.log);
            });
          }
        }
      });
    });
  };

  const gotMessageFromServer = (fromId, message) => {
    const signal = JSON.parse(message);
    if (fromId !== socketIdRef.current) {
      if (signal.sdp) {
        connections[fromId].setRemoteDescription(new RTCSessionDescription(signal.sdp)).then(() => {
          if (signal.sdp.type === 'offer') {
            connections[fromId].createAnswer().then((description) => {
              connections[fromId].setLocalDescription(description).then(() => {
                socketRef.current.emit('signal', fromId, JSON.stringify({ sdp: connections[fromId].localDescription }));
              }).catch(console.log);
            }).catch(console.log);
          }
        }).catch(console.log);
      }
      if (signal.ice) {
        connections[fromId].addIceCandidate(new RTCIceCandidate(signal.ice)).catch(console.log);
      }
    }
  };

  // ===== Helpers to swap outgoing tracks on all peers =====
  const replaceOutgoingTracks = async (nextStream) => {
    // Update local refs/UI
    currentOutStreamRef.current = nextStream;
    window.localStream = nextStream;
    setSelfStream(nextStream);
    if (localVideoref.current) localVideoref.current.srcObject = nextStream;

    // For each connection, replace video/audio tracks in-place
    Object.values(connections).forEach((pc) => {
      const senders = pc.getSenders ? pc.getSenders() : [];
      const nextVideo = nextStream.getVideoTracks()[0] || null;
      const nextAudio = nextStream.getAudioTracks()[0] || null;

      const videoSender = senders.find(s => s.track && s.track.kind === 'video');
      const audioSender = senders.find(s => s.track && s.track.kind === 'audio');

      if (videoSender) {
        videoSender.replaceTrack(nextVideo).catch(console.log);
      }
      if (audioSender) {
        audioSender.replaceTrack(nextAudio).catch(console.log);
      }

      // If no sender existed (older path), fall back to addStream once
      if (!videoSender && !audioSender && pc.addStream) {
        try { pc.addStream(nextStream); } catch {}
      }
    });
  };

  // ===== Screen share (fixed) =====
  const startScreenShare = async () => {
    try {
      // 1) Get screen video (and system audio if available)
      const screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: { cursor: 'always' },
        audio: true // may or may not be granted; we'll handle both cases
      });

      // 2) Ensure we have *some* audio (system or mic). If system audio is missing,
      //    grab mic and merge it with the screen video.
      let finalStream;
      const screenVideoTrack = screenStream.getVideoTracks()[0] || null;
      const screenAudioTrack = screenStream.getAudioTracks()[0] || null;

      if (screenAudioTrack) {
        finalStream = screenStream;
      } else {
        // Mix mic with screen video
        const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
        finalStream = new MediaStream([
          ...(screenVideoTrack ? [screenVideoTrack] : []),
          ...(mic.getAudioTracks() || [])
        ]);
      }

      // 3) Replace outgoing tracks in-place (no renegotiation flood)
      await replaceOutgoingTracks(finalStream);

      // 4) When user stops sharing, revert to camera
      const onEnded = async () => {
        await stopScreenShare(); // clean revert
      };
      // attach onended to whichever video track we used
      const vt = finalStream.getVideoTracks()[0];
      if (vt) vt.onended = onEnded;

      setScreen(true);
    } catch (err) {
      console.log('Screen share error:', err);
      // if user cancels picker or browser blocks, just ensure screen=false
      setScreen(false);
    }
  };

  const stopScreenShare = async () => {
    try {
      // Stop current outgoing tracks (screen)
      currentOutStreamRef.current?.getTracks?.().forEach(t => {
        // Don't stop mic/cam if it's the same as camStreamRef
        if (!camStreamRef.current || !camStreamRef.current.getTracks().includes(t)) {
          try { t.stop(); } catch {}
        }
      });
    } catch {}

    // Revert to camera (reacquire if needed)
    if (!camStreamRef.current) {
      try {
        camStreamRef.current = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      } catch (e) {
        console.log('Reacquire camera failed:', e);
      }
    }
    if (camStreamRef.current) {
      await replaceOutgoingTracks(camStreamRef.current);
    }
    setScreen(false);
  };

  // Toggle handler
  const handleScreen = () => {
    if (screen) {
      stopScreenShare();
    } else {
      startScreenShare();
    }
  };

  // ===== Camera / Mic toggles (no re-acquire) =====
  const handleVideo = () => {
    const s = localVideoref.current?.srcObject || currentOutStreamRef.current || camStreamRef.current || selfStream;
    const t = s?.getVideoTracks?.()[0];
    if (t) {
      t.enabled = !t.enabled;
      setVideo(t.enabled);
    } else {
      setVideo(v => !v);
    }
  };

  const handleAudio = () => {
    const s = localVideoref.current?.srcObject || currentOutStreamRef.current || camStreamRef.current || selfStream;
    const t = s?.getAudioTracks?.()[0];
    if (t) {
      t.enabled = !t.enabled;
      setAudio(t.enabled);
    } else {
      setAudio(a => !a);
    }
  };

  const handleEndCall = () => {
    try { localVideoref.current?.srcObject?.getTracks?.().forEach(track => track.stop()); } catch{}
    try { socketRef.current?.disconnect(); } catch {}
     navigate("/home", { replace: true });
   
  };

  // ===== Chat =====
  const handleMessage = (e) => setMessage(e.target.value);
  const addMessage = (data, sender, socketIdSender) => {
    setMessages(prev => [...prev, { sender, data }]);
    if (!showModal && socketIdSender !== socketIdRef.current) {
      setNewMessages(prev => prev + 1);
    }
  };
  const sendMessage = () => {
    if (!message.trim()) return;
    socketRef.current.emit('chat-message', message, username);
    setMessage("");
  };
  useEffect(() => { if (showModal) setNewMessages(0); }, [showModal]);

  const connect = () => {
    if (!username.trim()) return;
    setAskForUsername(false);
    connectToSocketServer();
  };

  return (
    <div>
      {askForUsername ? (
        <div>
          <h2>Enter into Lobby </h2>
          <TextField id="outlined-basic" label="Username" value={username} onChange={e => setUsername(e.target.value)} variant="outlined" />
          <Button variant="contained" onClick={connect}>Connect</Button>

          <div>
            {/* Local preview (used for track toggles) */}
            <video ref={localVideoref} autoPlay muted playsInline style={{ width: 320, borderRadius: 8, background: '#111' }} />
          </div>
        </div>
      ) : (
        <div className={styles.meetVideoContainer}>

          {/* CHAT PANEL (kept from your last fixed version) */}
          {showModal ? (
            <div className={styles.chatRoom} style={{ height: '80vh', maxHeight: '80vh' }}>
              <div
                className={styles.chatContainer}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  height: '100%',
                  background: 'rgba(0,0,0,0.35)',
                  borderRadius: 12,
                  padding: 12,
                  boxSizing: 'border-box'
                }}
              >
                <h1 style={{ margin: 0, marginBottom: 8, fontSize: 18 }}>Chat</h1>
                <div
                  className={styles.chattingDisplay}
                  style={{ flex: 1, minHeight: 0, overflowY: 'auto', paddingRight: 6 }}
                >
                  {messages.length
                    ? messages.map((item, index) => (
                        <div style={{ marginBottom: 12 }} key={index}>
                          <p style={{ fontWeight: 'bold', margin: 0 }}>{item.sender}</p>
                          <p style={{ margin: 0 }}>{item.data}</p>
                        </div>
                      ))
                    : <p style={{ margin: 0 }}>No Messages Yet</p>}
                </div>
                <div
                  className={styles.chattingArea}
                  style={{
                    display: 'flex',
                    gap: 8,
                    paddingTop: 8,
                    alignItems: 'center',
                    position: 'sticky',
                    bottom: 0,
                    background: 'rgba(0,0,0,0.35)',
                    borderRadius: 10,
                    padding: 8,
                    marginTop: 8
                  }}
                >
                  <TextField
                    value={message}
                    onChange={handleMessage}
                    id="outlined-basic"
                    label="Enter your chat"
                    variant="outlined"
                    fullWidth
                    onKeyDown={(e) => { if (e.key === 'Enter') sendMessage(); }}
                  />
                  <Button variant='contained' onClick={sendMessage}>Send</Button>
                </div>
              </div>
            </div>
          ) : null}

          {/* CONTROLS */}
          <div className={styles.buttonContainers}>
            <IconButton onClick={handleVideo} style={{ color: "white" }}>
              {video ? <VideocamIcon /> : <VideocamOffIcon />}
            </IconButton>
            <IconButton onClick={handleEndCall} style={{ color: "red" }}>
              <CallEndIcon  />
            </IconButton>
            <IconButton onClick={handleAudio} style={{ color: "white" }}>
              {audio ? <MicIcon /> : <MicOffIcon />}
            </IconButton>
            {screenAvailable ? (
              <IconButton onClick={handleScreen} style={{ color: "white" }}>
                {screen ? <StopScreenShareIcon /> : <ScreenShareIcon />}
              </IconButton>
            ) : null}
            <Badge badgeContent={newMessages} max={999} color='primary'>
              <IconButton onClick={() => setModal(m => !m)} style={{ color: "white" }}>
                <ChatIcon />
              </IconButton>
            </Badge>
          </div>

          {/* CONFERENCE GRID — includes YOUR tile first */}
          <div className={styles.conferenceView}>
            {selfStream && (
              <div key="self">
                <video
                  autoPlay
                  muted
                  playsInline
                  ref={(ref) => {
                    if (ref && ref.srcObject !== selfStream) ref.srcObject = selfStream;
                  }}
                  style={{ width: '100%', borderRadius: 8, background: '#111' }}
                />
                <div style={{ marginTop: 6, color: '#bbb', fontSize: 12 }}>
                  You{username ? ` (${username})` : ''}
                </div>
              </div>
            )}

            {videos.map((v) => (
              <div key={v.socketId}>
                <video
                  data-socket={v.socketId}
                  ref={ref => {
                    if (ref && v.stream && ref.srcObject !== v.stream) {
                      ref.srcObject = v.stream;
                    }
                  }}
                  autoPlay
                  playsInline
                  style={{ width: '100%', borderRadius: 8, background: '#111' }}
                />
                <div style={{ marginTop: 6, color: '#bbb', fontSize: 12 }}>
                  {names[v.socketId] || 'Guest'}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
