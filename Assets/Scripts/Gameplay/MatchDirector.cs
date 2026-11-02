using System.Collections;
using System.Collections.Generic;
using UnityEngine;

namespace PopPopArena.Gameplay
{
    public sealed class MatchDirector : MonoBehaviour
    {
        public static MatchDirector Instance { get; private set; }
        private readonly List<GridPlayerController> players = new();
        private float remaining = 120f;
        private int safeRadius = 5;
        private float nextShrinkAt = 30f;
        private bool finished;
        private string result = "";
        private bool started;

        public bool CanPlay => started && !finished;
        public bool IsFinished => finished;
        public string Result => result;
        public GridPlayerController LocalPlayer { get; private set; }

        private void Awake() => Instance = this;

        public void Register(GridPlayerController player)
        {
            players.Add(player);
            if (player.name == "P1") LocalPlayer = player;
        }

        public void BeginMatch() => started = true;
        public void RestartMatch() => UnityEngine.SceneManagement.SceneManager.LoadScene(UnityEngine.SceneManagement.SceneManager.GetActiveScene().buildIndex);
        public void BeginBubbleCountdown(GridPlayerController player) => StartCoroutine(BubbleTimeout(player));

        private IEnumerator BubbleTimeout(GridPlayerController player)
        {
            yield return new WaitForSeconds(2f);
            if (player.IsBubbled) player.Eliminate();
        }

        private void Update()
        {
            if (!started || finished) return;
            remaining -= Time.deltaTime;
            if (remaining <= nextShrinkAt && safeRadius > 2)
            {
                safeRadius--;
                nextShrinkAt -= 10f;
            }
            if (remaining <= 0f) EvaluateWinner();
            foreach (var player in players)
                if (!player.IsEliminated && Mathf.Max(Mathf.Abs(player.Cell.x - 6), Mathf.Abs(player.Cell.y - 5)) > safeRadius)
                    player.HitByWave();
        }

        public void TryRescueBy(GridPlayerController rescuer)
        {
            foreach (var player in players)
                if (player != rescuer && player.IsBubbled && Vector2Int.Distance(player.Cell, rescuer.Cell) <= 1.1f)
                    player.Rescue();
        }

        public void EvaluateWinner()
        {
            if (finished) return;
            GridPlayerController survivor = null;
            foreach (var player in players) if (!player.IsEliminated) survivor = player;
            finished = true;
            result = survivor == null ? "무승부" : survivor.name + " 승리!";
        }

        private void OnGUI()
        {
            if (started) GUI.Label(new Rect(16, 12, 300, 30), "남은 시간  " + Mathf.CeilToInt(Mathf.Max(0, remaining)) + "초");
        }
    }
}
