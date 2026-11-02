using System.Collections.Generic;
using PopPopArena.Core;
using PopPopArena.Gameplay;
using UnityEngine;

namespace PopPopArena.Networking
{
    /// <summary>서버 state를 임시 프리미티브에 반영한다. 최종 IP 프리팹은 이 렌더러만 교체하면 된다.</summary>
    public sealed class NetworkArenaRenderer : MonoBehaviour
    {
        [SerializeField] private WebGlSocketClient socketClient;
        [SerializeField] private ArenaGrid grid;
        private readonly Dictionary<string, GameObject> orbViews = new();
        private readonly Dictionary<string, GameObject> waveViews = new();

        private void Start()
        {
            if (socketClient == null) socketClient = GetComponent<WebGlSocketClient>();
            if (grid == null) grid = GetComponent<ArenaGrid>();
            if (socketClient != null) socketClient.StateReceived += Render;
        }
        private void OnDestroy() { if (socketClient != null) socketClient.StateReceived -= Render; }

        private void Render(ArenaState state)
        {
            if (grid == null) return;
            RenderPlayers(state.players);
            RenderSoftBlocks(state.soft);
            SyncOrbs(state.orbs);
            SyncWaves(state.waves);
        }
        private void RenderPlayers(PlayerState[] players)
        {
            if (players == null) return;
            foreach (var player in players)
            {
                var target = player.id == socketClient.PlayerId ? GameObject.Find("P1") : GameObject.Find("P2");
                if (target == null) continue;
                target.SetActive(player.alive);
                if (player.alive)
                {
                    target.transform.position = grid.ToWorld(new Vector2Int(player.x, player.y)) + Vector3.up * .5f;
                    target.GetComponent<Renderer>().material.color = player.bubbleTicks > 0 ? Color.white : (target.name == "P1" ? new Color(.35f, .8f, 1f) : new Color(1f, .5f, .75f));
                }
            }
        }
        private void RenderSoftBlocks(string[] soft)
        {
            if (soft == null) return;
            var remaining = new HashSet<string>(soft);
            foreach (var renderer in FindObjectsByType<Renderer>(FindObjectsSortMode.None))
            {
                if (renderer.gameObject.name != "CloudBox") continue;
                var point = renderer.transform.position;
                var cell = $"{Mathf.RoundToInt(point.x + 6)},{Mathf.RoundToInt(point.z + 5)}";
                if (!remaining.Contains(cell)) Destroy(renderer.gameObject);
            }
        }
        private void SyncOrbs(OrbState[] orbs)
        {
            Sync(orbViews, orbs, "ServerOrb", PrimitiveType.Sphere, new Color(.4f, 1f, .8f), .56f);
        }
        private void SyncWaves(WaveState[] waves)
        {
            Sync(waveViews, waves, "ServerWave", PrimitiveType.Cube, new Color(1f, .9f, .25f), .8f);
        }
        private void Sync(Dictionary<string, GameObject> views, OrbState[] effects, string label, PrimitiveType shape, Color color, float size)
        {
            var live = new HashSet<string>();
            if (effects != null) foreach (var effect in effects) AddEffect(views, live, effect.x, effect.y, label, shape, color, size);
            RemoveAbsent(views, live);
        }
        private void Sync(Dictionary<string, GameObject> views, WaveState[] effects, string label, PrimitiveType shape, Color color, float size)
        {
            var live = new HashSet<string>();
            if (effects != null) foreach (var effect in effects) AddEffect(views, live, effect.x, effect.y, label, shape, color, size);
            RemoveAbsent(views, live);
        }
        private void AddEffect(Dictionary<string, GameObject> views, HashSet<string> live, int x, int y, string label, PrimitiveType shape, Color color, float size)
        {
            var id = $"{x},{y}"; live.Add(id);
            if (!views.TryGetValue(id, out var view))
            {
                view = GameObject.CreatePrimitive(shape); view.name = label;
                view.transform.localScale = new Vector3(size, shape == PrimitiveType.Cube ? .2f : size, size);
                view.GetComponent<Renderer>().material.color = color; views[id] = view;
            }
            view.transform.position = grid.ToWorld(new Vector2Int(x, y)) + Vector3.up * (shape == PrimitiveType.Cube ? .12f : .3f);
        }
        private void RemoveAbsent(Dictionary<string, GameObject> views, HashSet<string> live)
        {
            foreach (var id in new List<string>(views.Keys)) if (!live.Contains(id)) { Destroy(views[id]); views.Remove(id); }
        }
    }
}
