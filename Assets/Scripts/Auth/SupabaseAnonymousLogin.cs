using System;
using System.Runtime.InteropServices;
using PopPopArena.Networking;
using UnityEngine;

namespace PopPopArena.Auth
{
    /// <summary>공개 anon key만 사용한다. 서비스 역할 키는 절대 Unity 빌드에 넣지 않는다.</summary>
    public sealed class SupabaseAnonymousLogin : MonoBehaviour
    {
        [SerializeField] private string supabaseUrl;
        [SerializeField] private string supabaseAnonKey;
        [SerializeField] private WebGlSocketClient socketClient;
        public string AccessToken { get; private set; }
        public bool IsAuthenticating { get; private set; }
        public string AuthenticationError { get; private set; }
        private long expiresAt;
        public bool IsReady => !string.IsNullOrWhiteSpace(AccessToken) && expiresAt > DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 60;

#if UNITY_WEBGL && !UNITY_EDITOR
        [DllImport("__Internal")] private static extern void PPP_AnonymousLogin(string url, string anonKey, string objectName, string callback);
#endif
        private void Start()
        {
            if (socketClient == null) socketClient = GetComponent<WebGlSocketClient>();
            Login();
        }
        public void Login()
        {
            if (IsAuthenticating) return;
            if (string.IsNullOrWhiteSpace(supabaseUrl) || string.IsNullOrWhiteSpace(supabaseAnonKey))
            {
                AuthenticationError = "Supabase 설정이 필요합니다.";
                return;
            }
#if UNITY_WEBGL && !UNITY_EDITOR
            IsAuthenticating = true;
            AuthenticationError = null;
            PPP_AnonymousLogin(supabaseUrl, supabaseAnonKey, gameObject.name, nameof(OnSupabaseAuth));
#else
            AuthenticationError = "온라인 로그인은 WebGL 빌드에서 사용할 수 있습니다.";
#endif
        }
        public void OnSupabaseAuth(string json)
        {
            IsAuthenticating = false;
            var response = JsonUtility.FromJson<AuthResponse>(json);
            if (response == null || string.IsNullOrWhiteSpace(response.access_token))
            {
                AuthenticationError = "로그인에 실패했습니다. 다시 시도해 주세요.";
                return;
            }
            AccessToken = response.access_token;
            expiresAt = response.expires_at;
            AuthenticationError = null;
            if (socketClient != null) socketClient.SetAccessToken(AccessToken);
        }
        [Serializable] private sealed class AuthResponse { public string access_token; public long expires_at; }
    }
}
