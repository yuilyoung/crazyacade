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
            if (string.IsNullOrWhiteSpace(supabaseUrl) || string.IsNullOrWhiteSpace(supabaseAnonKey)) { Debug.Log("Supabase URL/anon key is not configured."); return; }
#if UNITY_WEBGL && !UNITY_EDITOR
            PPP_AnonymousLogin(supabaseUrl, supabaseAnonKey, gameObject.name, nameof(OnSupabaseAuth));
#else
            Debug.Log("Supabase browser login activates in a WebGL build.");
#endif
        }
        public void OnSupabaseAuth(string json)
        {
            var response = JsonUtility.FromJson<AuthResponse>(json);
            if (string.IsNullOrWhiteSpace(response.access_token)) { Debug.LogWarning("Supabase login failed."); return; }
            AccessToken = response.access_token;
            socketClient.SetAccessToken(AccessToken);
            socketClient.Connect();
        }
        [Serializable] private sealed class AuthResponse { public string access_token; }
    }
}
