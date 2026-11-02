using UnityEngine;
using PopPopArena.Networking;

namespace PopPopArena.Gameplay
{
    /// <summary>임시 UI. 최종 UI 프리팹·아트 확정 전에도 모바일 터치 조작을 검증한다.</summary>
    public sealed class MobileHud : MonoBehaviour
    {
        private MatchDirector director;
        private GUIStyle titleStyle;

        private void Start()
        {
            director = MatchDirector.Instance;
            titleStyle = new GUIStyle(GUI.skin.label) { alignment = TextAnchor.MiddleCenter, fontSize = 28, fontStyle = FontStyle.Bold };
        }

        private void OnGUI()
        {
            if (director == null) return;
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
                GUI.Label(new Rect(0, Screen.height * .22f, Screen.width, 42), "POP POP ARENA", titleStyle);
                GUI.Label(new Rect(0, Screen.height * .30f, Screen.width, 25), "2분 안에 상대를 버블에 가두세요", new GUIStyle(GUI.skin.label) { alignment = TextAnchor.MiddleCenter });
                if (GUI.Button(Centered(180, 55, .42f), "게임 시작")) director.BeginMatch();
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
