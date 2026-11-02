using UnityEngine;
using PopPopArena.Networking;
using PopPopArena.Auth;

namespace PopPopArena.Gameplay
{
    /// <summary>임시 UI. 최종 UI 프리팹·아트 확정 전에도 모바일 터치 조작을 검증한다.</summary>
    public sealed class MobileHud : MonoBehaviour
    {
        private MatchDirector director;
        private GUIStyle titleStyle;
        private SupabaseAnonymousLogin auth;
        private WebGlSocketClient socket;
        private int characterIndex, skinIndex, mapIndex;
        private static readonly string[] Characters = { "momo", "nori", "bibi", "toto" };
        private static readonly string[] Skins = { "classic", "sunset", "mint" };
        private static readonly string[] Maps = { "garden", "lagoon", "candy" };

        private void Start()
        {
            director = MatchDirector.Instance;
            auth = GetComponent<SupabaseAnonymousLogin>();
            socket = GetComponent<WebGlSocketClient>();
        }

        private void OnGUI()
        {
            if (director == null) return;
            if (titleStyle == null) titleStyle = new GUIStyle(GUI.skin.label) { alignment = TextAnchor.MiddleCenter, fontSize = 28, fontStyle = FontStyle.Bold };
            if (OnlineInputRouter.WasDisconnected)
            {
                GUI.Label(new Rect(0, Screen.height * .26f, Screen.width, 42), "연결이 끊겼습니다", titleStyle);
                if (GUI.Button(Centered(180, 55, .42f), "다시 시작")) director.RestartMatch();
                return;
            }
            if (OnlineInputRouter.IsOnline)
            {
                DrawOnline();
                return;
            }
            if (!director.CanPlay && !director.IsFinished)
            {
                if (auth != null && socket != null) DrawSelection();
                else
                {
                    GUI.Label(new Rect(0, Screen.height * .22f, Screen.width, 42), "POP POP ARENA", titleStyle);
                    if (GUI.Button(Centered(180, 55, .42f), "로컬 게임 시작")) director.BeginMatch();
                }
                return;
            }
            if (director.IsFinished)
            {
                GUI.Label(new Rect(0, Screen.height * .26f, Screen.width, 42), director.Result, titleStyle);
                if (GUI.Button(Centered(180, 55, .42f), "다시 하기")) director.RestartMatch();
                return;
            }

            var player = director.LocalPlayer;
            if (player == null || player.IsEliminated) return;
            var size = Mathf.Clamp(Screen.width * .13f, 58f, 100f);
            var x = size * .35f;
            var y = Screen.height - size * 2.15f;
            if (GUI.RepeatButton(new Rect(x + size, y, size, size), "▲")) Move(player, "up", Vector2Int.up);
            if (GUI.RepeatButton(new Rect(x, y + size, size, size), "◀")) Move(player, "left", Vector2Int.left);
            if (GUI.RepeatButton(new Rect(x + size, y + size, size, size), "▼")) Move(player, "down", Vector2Int.down);
            if (GUI.RepeatButton(new Rect(x + size * 2, y + size, size, size), "▶")) Move(player, "right", Vector2Int.right);
            if (GUI.Button(new Rect(Screen.width - size * 1.65f, Screen.height - size * 1.75f, size * 1.35f, size * 1.35f), "POP")) { if (!OnlineInputRouter.TrySend("place_orb")) player.TryPlaceOrb(); }
        }

        private void DrawSelection()
        {
            var oldMatrix = GUI.matrix;
            var scale = Mathf.Min(1f, Screen.height / 410f);
            GUI.matrix = Matrix4x4.Scale(new Vector3(scale, scale, 1)) * oldMatrix;
            var logicalWidth = Screen.width / scale;
            var width = Mathf.Min(logicalWidth - 24, 520);
            var left = (logicalWidth - width) * .5f;
            var y = 8f;
            GUI.Label(new Rect(left, y, width, 36), "POP POP ARENA", titleStyle); y += 40;
            GUI.Label(new Rect(left, y, width, 22), "캐릭터"); y += 22;
            characterIndex = GUI.Toolbar(new Rect(left, y, width, 35), characterIndex, Characters); y += 38;
            GUI.Label(new Rect(left, y, width, 22), "스킨"); y += 22;
            skinIndex = GUI.Toolbar(new Rect(left, y, width, 35), skinIndex, Skins); y += 38;
            GUI.Label(new Rect(left, y, width, 22), "맵 (같은 방 참가자는 같은 맵 선택)"); y += 22;
            mapIndex = GUI.Toolbar(new Rect(left, y, width, 35), mapIndex, Maps); y += 41;

            if (auth.IsAuthenticating) GUI.Label(new Rect(left, y, width, 25), "로그인 중...");
            else if (!auth.IsReady)
            {
                GUI.Label(new Rect(left, y, width, 25), auth.AuthenticationError ?? "로그인이 필요합니다.");
                y += 25;
                if (GUI.Button(new Rect(left, y, width, 35), "로그인 다시 시도")) auth.Login();
            }
            else if (socket.Connecting) GUI.Label(new Rect(left, y, width, 25), "방에 입장 중...");
            else
            {
                if (!string.IsNullOrEmpty(socket.SocketError))
                {
                    GUI.Label(new Rect(left, y, width, 24), "입장 실패: " + socket.SocketError);
                    y += 24;
                }
                if (GUI.Button(new Rect(left, y, width, 40), "온라인 입장"))
                {
                    socket.SetSelections(Characters[characterIndex], Skins[skinIndex], Maps[mapIndex]);
                    socket.Connect();
                }
            }
            y += 44;
            if (!socket.Connecting && GUI.Button(new Rect(left, y, width, 35), "로컬 게임 시작")) director.BeginMatch();
            GUI.matrix = oldMatrix;
        }

        private void DrawOnline()
        {
            var state = OnlineInputRouter.State;
            if (state == null || state.phase == "waiting")
            {
                var count = state?.players?.Length ?? 0;
                var required = state?.mode == "team" ? 8 : 2;
                GUI.Label(new Rect(0, Screen.height * .3f, Screen.width, 40), $"참가자 대기 중  {count}/{required}", titleStyle);
                return;
            }
            if (state.phase == "finished")
            {
                var result = state.result;
                var label = result == null || result.draw ? "무승부" :
                    !string.IsNullOrEmpty(result.winnerTeam) ? result.winnerTeam + " 팀 승리!" : "경기 종료";
                GUI.Label(new Rect(0, Screen.height * .26f, Screen.width, 42), label, titleStyle);
                if (GUI.Button(Centered(180, 55, .42f), "다시 시작")) director.RestartMatch();
                return;
            }
            GUI.Label(new Rect(16, 12, 300, 30), "남은 시간  " + Mathf.CeilToInt(state.remaining / 10f) + "초");
            var size = Mathf.Clamp(Screen.width * .13f, 58f, 100f);
            var x = size * .35f;
            var y = Screen.height - size * 2.15f;
            if (GUI.RepeatButton(new Rect(x + size, y, size, size), "▲")) OnlineInputRouter.TrySend("up");
            if (GUI.RepeatButton(new Rect(x, y + size, size, size), "◀")) OnlineInputRouter.TrySend("left");
            if (GUI.RepeatButton(new Rect(x + size, y + size, size, size), "▼")) OnlineInputRouter.TrySend("down");
            if (GUI.RepeatButton(new Rect(x + size * 2, y + size, size, size), "▶")) OnlineInputRouter.TrySend("right");
            if (GUI.Button(new Rect(Screen.width - size * 1.65f, Screen.height - size * 1.75f, size * 1.35f, size * 1.35f), "POP")) OnlineInputRouter.TrySend("place_orb");
        }

        private static Rect Centered(float width, float height, float vertical) => new((Screen.width - width) * .5f, Screen.height * vertical, width, height);
        private static void Move(GridPlayerController player, string action, Vector2Int direction) { if (!OnlineInputRouter.TrySend(action)) player.TryMove(direction); }
    }
}
