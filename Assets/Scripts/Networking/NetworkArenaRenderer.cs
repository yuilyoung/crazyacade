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
        private readonly Dictionary<string, GameObject> playerViews = new();
        private readonly Dictionary<string, GameObject> softViews = new();
        private bool softInitialized;
        private readonly Dictionary<string, GameObject> itemViews = new();
        private readonly Dictionary<string, GameObject> orbViews = new();
        private readonly Dictionary<string, GameObject> waveViews = new();

        private void Start()
        {
            if (socketClient == null) socketClient = GetComponent<WebGlSocketClient>();
            if (grid == null) grid = GetComponent<ArenaGrid>();
            if (socketClient != null) socketClient.StateReceived += Render;
        }
        private void OnDestroy() { if (socketClient != null) socketClient.StateReceived -= Render; }

        private void OnGUI()
        {
            var state = socketClient != null ? socketClient.LatestState : null;
            if (state == null || state.phase != "playing" || state.players == null) return;
            foreach (var player in state.players)
            {
                if (player == null || player.id != socketClient.PlayerId) continue;
                var x = Mathf.Max(0, Screen.width - 240);
                GUI.Box(new Rect(x, 8, 232, state.mode == "team" ? 72 : 52), "아이템 능력");
                GUI.Label(new Rect(x + 8, 27, 220, 22), $"오브 {player.maxOrbs}  파동 {player.range}  대시 {(player.dash ? "✓" : "-")}  핀 {(player.pin ? "✓" : "-")}");
                if (state.mode == "team") GUI.Label(new Rect(x + 8, 47, 220, 22), "버블 아군 곁으로 이동해 구조");
                break;
            }
        }
        private void Render(ArenaState state)
        {
            if (grid == null) return;
            RenderPlayers(state.players);
            RenderSoftBlocks(state.soft);
            SyncItems(state.items);
            SyncOrbs(state.orbs);
            SyncWaves(state.waves);
        }
        private void RenderPlayers(PlayerState[] players)
        {
            // Local controllers supply input only while online. Server identities get independent views.
            foreach (var controller in FindObjectsByType<GridPlayerController>(FindObjectsSortMode.None))
                if (controller.TryGetComponent<Renderer>(out var localRenderer)) localRenderer.enabled = false;
            var live = new HashSet<string>();
            if (players != null) foreach (var player in players)
            {
                if (player == null || string.IsNullOrEmpty(player.id)) continue;
                live.Add(player.id);
                if (!playerViews.TryGetValue(player.id, out var view))
                {
                    view = GameObject.CreatePrimitive(PrimitiveType.Capsule);
                    view.name = "ServerPlayer-" + player.id;
                    // Network views are decorative, not physics participants.
                    var collider = view.GetComponent<Collider>();
                    if (collider != null) Destroy(collider);
                    var accent = GameObject.CreatePrimitive(PrimitiveType.Sphere);
                    accent.name = "CharacterAccent";
                    accent.transform.SetParent(view.transform, false);
                    accent.transform.localPosition = new Vector3(0, .75f, 0);
                    var accentCollider = accent.GetComponent<Collider>();
                    if (accentCollider != null) Destroy(accentCollider);
                    if (player.id == socketClient.PlayerId)
                    {
                        var marker = GameObject.CreatePrimitive(PrimitiveType.Sphere);
                        marker.name = "LocalPlayerMarker";
                        marker.transform.SetParent(view.transform, false);
                        marker.transform.localPosition = new Vector3(0, 1.25f, 0);
                        marker.transform.localScale = Vector3.one * .25f;
                        marker.GetComponent<Renderer>().material.color = Color.yellow;
                        var markerCollider = marker.GetComponent<Collider>();
                        if (markerCollider != null) Destroy(markerCollider);
                    }
                    playerViews[player.id] = view;
                }
                view.SetActive(player.alive);
                if (!player.alive) continue;
                view.transform.position = grid.ToWorld(new Vector2Int(player.x, player.y)) + Vector3.up * .5f;
                var accentView = view.transform.Find("CharacterAccent");
                if (accentView != null)
                {
                    accentView.localScale = player.characterId switch
                    {
                        "nori" => new Vector3(.55f, .2f, .25f),
                        "bibi" => new Vector3(.25f, .55f, .25f),
                        "toto" => new Vector3(.45f, .45f, .2f),
                        _ => Vector3.one * .3f
                    };
                    accentView.GetComponent<Renderer>().material.color = player.skinId switch
                    {
                        "sunset" => new Color(1f, .55f, .25f),
                        "mint" => new Color(.4f, 1f, .7f),
                        _ => Color.white
                    };
                }
                var blue = player.team == "blue" || (string.IsNullOrEmpty(player.team) && player.id == socketClient.PlayerId);
                view.GetComponent<Renderer>().material.color = player.bubbleTicks > 0 ? Color.white :
                    blue ? new Color(.35f, .8f, 1f) : new Color(1f, .5f, .75f);
            }
            RemoveAbsent(playerViews, live);
        }
        private void RenderSoftBlocks(string[] soft)
        {
            if (soft == null) return;
            if (!softInitialized)
            {
                foreach (var renderer in FindObjectsByType<Renderer>(FindObjectsSortMode.None))
                {
                    if (renderer.gameObject.name != "CloudBox") continue;
                    var point = renderer.transform.position;
                    var id = $"{Mathf.RoundToInt(point.x + 6)},{Mathf.RoundToInt(point.z + 5)}";
                    softViews[id] = renderer.gameObject;
                }
                softInitialized = true;
            }
            var live = new HashSet<string>(soft);
            RemoveAbsent(softViews, live);
            foreach (var id in live)
            {
                if (softViews.ContainsKey(id)) continue;
                var coordinates = id.Split(',');
                if (coordinates.Length != 2 || !int.TryParse(coordinates[0], out var x) || !int.TryParse(coordinates[1], out var y)) continue;
                var view = GameObject.CreatePrimitive(PrimitiveType.Cube);
                view.name = "CloudBox";
                view.transform.localScale = new Vector3(.82f, .72f, .82f);
                view.transform.position = grid.ToWorld(new Vector2Int(x, y)) + Vector3.up * .36f;
                view.GetComponent<Renderer>().material.color = new Color(1f, .72f, .43f);
                softViews[id] = view;
            }
        }
        private void SyncItems(ItemState[] items)
        {
            var live = new HashSet<string>();
            if (items != null) foreach (var item in items)
            {
                if (item == null) continue;
                var id = $"{item.x},{item.y}";
                live.Add(id);
                if (!itemViews.TryGetValue(id, out var view))
                {
                    view = GameObject.CreatePrimitive(PrimitiveType.Sphere);
                    view.name = "ServerItem";
                    view.transform.localScale = Vector3.one * .35f;
                    var collider = view.GetComponent<Collider>();
                    if (collider != null) Destroy(collider);
                    itemViews[id] = view;
                }
                view.transform.position = grid.ToWorld(new Vector2Int(item.x, item.y)) + Vector3.up * .28f;
                view.GetComponent<Renderer>().material.color = item.type switch
                {
                    "orb" => new Color(.3f, .9f, .85f),
                    "wave" => new Color(1f, .75f, .25f),
                    "dash" => new Color(.5f, .65f, 1f),
                    "pin" => new Color(1f, .45f, .7f),
                    _ => Color.gray
                };
            }
            RemoveAbsent(itemViews, live);
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
