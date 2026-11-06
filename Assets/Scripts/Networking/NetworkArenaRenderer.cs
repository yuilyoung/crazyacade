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
        [SerializeField] private ArenaBootstrap bootstrap;
        private bool arenaInitialized;
        private Transform viewRoot;
        private readonly HashSet<Vector2Int> terrainCells = new();
        private readonly Dictionary<string, GameObject> itemViews = new();
        private readonly Dictionary<string, GameObject> orbViews = new();
        private readonly Dictionary<string, GameObject> waveViews = new();

        private void Start()
        {
            if (socketClient == null) socketClient = GetComponent<WebGlSocketClient>();
            if (grid == null) grid = GetComponent<ArenaGrid>();
            if (bootstrap == null) bootstrap = GetComponent<ArenaBootstrap>();
            if (bootstrap == null && grid != null) bootstrap = grid.GetComponent<ArenaBootstrap>();
            viewRoot = new GameObject("NetworkArenaVisuals").transform;
            viewRoot.SetParent(transform, false);
            if (socketClient != null)
            {
                socketClient.StateReceived += Render;
                if (socketClient.LatestState != null) Render(socketClient.LatestState);
            }
        }
        private void OnDestroy()
        {
            if (socketClient != null) socketClient.StateReceived -= Render;
            if (grid != null) foreach (var cell in terrainCells) grid.Clear(cell);
            if (viewRoot != null) Destroy(viewRoot.gameObject);
        }

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
            if (grid == null || state == null) return;
            var previousWidth = grid.ActiveWidth;
            var previousHeight = grid.ActiveHeight;
            var width = state.arena != null ? state.arena.width : ArenaGrid.Width;
            var height = state.arena != null ? state.arena.height : ArenaGrid.Height;
            if (bootstrap != null) bootstrap.ConfigureOnlineArena(width, height);
            else
            {
                grid.ConfigureDimensions(width, height);
                if (!arenaInitialized) grid.ClearAll();
            }
            if (!arenaInitialized || previousWidth != grid.ActiveWidth || previousHeight != grid.ActiveHeight)
                terrainCells.Clear();
            arenaInitialized = true;
            RenderTerrain(state.solid, state.soft);
            RenderPlayers(state.players);
            SyncItems(state.items);
            SyncOrbs(state.orbs);
            SyncWaves(state.waves);
        }
        private void RenderPlayers(PlayerState[] players)
        {
            // The bootstrap hides its offline players; server identities get independent views.
            var live = new HashSet<string>();
            if (players != null) foreach (var player in players)
            {
                if (player == null || string.IsNullOrEmpty(player.id)) continue;
                live.Add(player.id);
                if (!playerViews.TryGetValue(player.id, out var view))
                {
                    view = GameObject.CreatePrimitive(PrimitiveType.Capsule);
                    view.name = "ServerPlayer-" + player.id;
                    view.transform.SetParent(viewRoot, true);
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
        private void RenderTerrain(string[] solid, string[] soft)
        {
            var desired = new Dictionary<Vector2Int, CellType>();
            AddTerrain(desired, soft, CellType.Soft);
            // Permanent and closed gate walls take precedence over malformed overlaps.
            AddTerrain(desired, solid, CellType.Solid);
            foreach (var cell in terrainCells)
                if (!desired.ContainsKey(cell)) grid.Clear(cell);
            terrainCells.Clear();
            foreach (var entry in desired)
            {
                terrainCells.Add(entry.Key);
                if (grid.Get(entry.Key) == entry.Value) continue;
                var solidCell = entry.Value == CellType.Solid;
                var view = GameObject.CreatePrimitive(PrimitiveType.Cube);
                view.name = solidCell ? "ServerWall" : "ServerBox";
                view.transform.SetParent(viewRoot, true);
                view.transform.localScale = solidCell ? new Vector3(1, .9f, 1) : new Vector3(.82f, .72f, .82f);
                view.transform.position = grid.ToWorld(entry.Key) + Vector3.up * (view.transform.localScale.y * .5f);
                view.GetComponent<Renderer>().material.color = solidCell ? new Color(.56f, .43f, .8f) : new Color(1f, .72f, .43f);
                grid.Set(entry.Key, entry.Value, view);
            }
        }

        private void AddTerrain(Dictionary<Vector2Int, CellType> desired, string[] cells, CellType type)
        {
            if (cells == null) return;
            foreach (var id in cells)
            {
                if (string.IsNullOrEmpty(id)) continue;
                var coordinates = id.Split(',');
                if (coordinates.Length != 2 || !int.TryParse(coordinates[0], out var x) || !int.TryParse(coordinates[1], out var y)) continue;
                var cell = new Vector2Int(x, y);
                if (grid.IsInside(cell)) desired[cell] = type;
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
                    view.transform.SetParent(viewRoot, true);
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
                view.transform.SetParent(viewRoot, true);
                view.transform.localScale = new Vector3(size, shape == PrimitiveType.Cube ? .2f : size, size);
                view.GetComponent<Renderer>().material.color = color; views[id] = view;
            }
            view.transform.position = grid.ToWorld(new Vector2Int(x, y)) + Vector3.up * (shape == PrimitiveType.Cube ? .12f : .3f);
        }
        private void RemoveAbsent(Dictionary<string, GameObject> views, HashSet<string> live)
        {
            foreach (var id in new List<string>(views.Keys))
            {
                if (live.Contains(id)) continue;
                if (views[id] != null) { views[id].SetActive(false); Destroy(views[id]); }
                views.Remove(id);
            }
        }
    }
}
