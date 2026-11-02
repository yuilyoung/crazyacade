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
        public static bool TrySend(string action)
        {
            if (Instance == null || Instance.socketClient == null || !Instance.socketClient.IsJoined) return false;
            Instance.socketClient.SendInput(action);
            return true;
        }
    }
}
