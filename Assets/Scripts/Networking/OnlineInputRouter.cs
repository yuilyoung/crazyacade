using PopPopArena.Gameplay;
using UnityEngine;

namespace PopPopArena.Networking
{
    /// <summary>온라인 연결이 완료된 경우에만 로컬 입력을 서버 입력으로 바꾼다.</summary>
    public sealed class OnlineInputRouter : MonoBehaviour
    {
        public static OnlineInputRouter Instance { get; private set; }
        [SerializeField] private WebGlSocketClient socketClient;
        private void Awake()
        {
            Instance = this;
            if (socketClient == null) socketClient = GetComponent<WebGlSocketClient>();
        }
        private void Update()
        {
            if (!IsOnline || State?.phase != "playing") return;
            if (Input.GetKeyDown(KeyCode.Space)) TrySend("place_orb");
            if (Input.GetKeyDown(KeyCode.W) || Input.GetKeyDown(KeyCode.UpArrow)) TrySend("up");
            else if (Input.GetKeyDown(KeyCode.S) || Input.GetKeyDown(KeyCode.DownArrow)) TrySend("down");
            else if (Input.GetKeyDown(KeyCode.A) || Input.GetKeyDown(KeyCode.LeftArrow)) TrySend("left");
            else if (Input.GetKeyDown(KeyCode.D) || Input.GetKeyDown(KeyCode.RightArrow)) TrySend("right");
        }
        public static bool IsOnline => Instance != null && Instance.socketClient != null && Instance.socketClient.IsJoined;
        public static bool WasDisconnected => Instance != null && Instance.socketClient != null && Instance.socketClient.WasDisconnected;
        public static ArenaState State => IsOnline ? Instance.socketClient.LatestState : null;
        public static bool TrySend(string action)
        {
            if (Instance == null || Instance.socketClient == null || !Instance.socketClient.IsJoined) return false;
            Instance.socketClient.SendInput(action);
            return true;
        }
    }
}
