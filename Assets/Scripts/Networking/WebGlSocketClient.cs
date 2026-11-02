using System;
using System.Runtime.InteropServices;
using UnityEngine;

namespace PopPopArena.Networking
{
    [Serializable] public sealed class PlayerState { public string id; public string name; public string team; public int x; public int y; public bool alive; public int bubbleTicks; }
    [Serializable] public sealed class OrbState { public int x; public int y; public int fuse; }
    [Serializable] public sealed class WaveState { public int x; public int y; public int ttl; }
    [Serializable] public sealed class ArenaState { public string type; public string roomId; public string phase; public string mode; public MatchResult result; public int tick; public int remaining; public PlayerState[] players; public string[] soft; public OrbState[] orbs; public WaveState[] waves; }
    [Serializable] public sealed class MatchResult { public string winnerId; public string winnerTeam; public bool draw; }
    [Serializable] public sealed class SocketMessage { public string type; public string playerId; public string roomId; public string code; }

    /// <summary>WebGL 브라우저 WebSocket 연결. 전투 결과를 확정하지 않고 서버 state를 소비한다.</summary>
    public sealed class WebGlSocketClient : MonoBehaviour
    {
        [SerializeField] private string serverUrl = "ws://localhost:8080";
        [SerializeField] private string roomId = "";
        [SerializeField] private string playerName = "Popper";
        [SerializeField] private bool teamMode = true;
        public string PlayerId { get; private set; }
        private string accessToken;
        public bool WasDisconnected { get; private set; }
        public bool IsJoined => !string.IsNullOrEmpty(PlayerId);
        public ArenaState LatestState { get; private set; }
        public event Action<ArenaState> StateReceived;

#if UNITY_WEBGL && !UNITY_EDITOR
        [DllImport("__Internal")] private static extern void PPP_Connect(string url, string objectName, string callback);
        [DllImport("__Internal")] private static extern void PPP_Send(string message);
        [DllImport("__Internal")] private static extern void PPP_Close();
#endif
        public void Connect()
        {
            WasDisconnected = false;
#if UNITY_WEBGL && !UNITY_EDITOR
            PPP_Connect(serverUrl, gameObject.name, nameof(OnSocketMessage));
            SendRaw(JsonUtility.ToJson(new JoinRequest { type = "join", roomId = string.IsNullOrWhiteSpace(roomId) ? (teamMode ? "team-quick" : "quick") : roomId, name = playerName, accessToken = accessToken, mode = teamMode ? "team" : "duel" }));
#else
            Debug.Log("WebSocket bridge activates in a WebGL build. Configure a wss:// URL for production.");
#endif
        }
        public void SendInput(string action) => SendRaw(JsonUtility.ToJson(new InputRequest { type = "input", action = action }));
        public void SetAccessToken(string token) => accessToken = token;
        public void OnSocketMessage(string json)
        {
            var header = JsonUtility.FromJson<SocketMessage>(json);
            if (header.type == "joined") PlayerId = header.playerId;
            if (header.type == "state") { LatestState = JsonUtility.FromJson<ArenaState>(json); StateReceived?.Invoke(LatestState); }
            if (header.type == "error")
            {
                if (header.code == "socket_closed") { WasDisconnected = true; PlayerId = null; LatestState = null; }
                Debug.LogWarning("Socket error: " + header.code);
            }
        }
        private void SendRaw(string json)
        {
#if UNITY_WEBGL && !UNITY_EDITOR
            PPP_Send(json);
#endif
        }
        private void OnDestroy()
        {
#if UNITY_WEBGL && !UNITY_EDITOR
            PPP_Close();
#endif
        }
        [Serializable] private sealed class JoinRequest { public string type; public string roomId; public string name; public string accessToken; public string mode; }
        [Serializable] private sealed class InputRequest { public string type; public string action; }
    }
}
