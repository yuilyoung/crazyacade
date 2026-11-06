using PopPopArena.Core;
using PopPopArena.Networking;
using UnityEngine;

namespace PopPopArena.Gameplay
{
    public sealed class ArenaBootstrap : MonoBehaviour
    {
        [SerializeField] private ArenaGrid grid;
        private GameObject floorRoot;
        private readonly System.Collections.Generic.List<GameObject> localPlayers = new();
        private bool onlineArena;
        private Camera arenaCamera;
        private float framedAspect;

        private void Awake()
        {
            if (grid == null) grid = GetComponent<ArenaGrid>();
            if (grid == null) grid = gameObject.AddComponent<ArenaGrid>();
            if (GetComponent<MatchDirector>() == null) gameObject.AddComponent<MatchDirector>();
            if (GetComponent<MobileHud>() == null) gameObject.AddComponent<MobileHud>();
            if (GetComponent<OnlineInputRouter>() == null) gameObject.AddComponent<OnlineInputRouter>();
            CreateFloor();
            CreateWallsAndBoxes();
            CreatePlayer("P1", new Vector2Int(1, 1), KeyCode.W, KeyCode.S, KeyCode.A, KeyCode.D, KeyCode.Space, new Color(.35f, .8f, 1f));
            CreatePlayer("P2", new Vector2Int(ArenaGrid.Width - 2, ArenaGrid.Height - 2), KeyCode.UpArrow, KeyCode.DownArrow, KeyCode.LeftArrow, KeyCode.RightArrow, KeyCode.RightControl, new Color(1f, .5f, .75f));
            SetupCamera();
        }

        /// <summary>Switch this bootstrap's owned floor/terrain/camera to server geometry.</summary>
        public void ConfigureOnlineArena(int width, int height)
        {
            var dimensionsChanged = grid.ConfigureDimensions(width, height);
            var firstSnapshot = !onlineArena;
            if (firstSnapshot)
            {
                grid.ClearAll();
                foreach (var player in localPlayers) if (player != null) player.SetActive(false);
                onlineArena = true;
            }
            if (dimensionsChanged) CreateFloor();
            if (dimensionsChanged || firstSnapshot) FrameOnlineArena();
        }

        private void LateUpdate()
        {
            if (onlineArena && arenaCamera != null && !Mathf.Approximately(framedAspect, arenaCamera.aspect))
                FrameOnlineArena();
        }

        private void CreateFloor()
        {
            if (floorRoot != null) { floorRoot.SetActive(false); Destroy(floorRoot); }
            floorRoot = new GameObject("ArenaFloor");
            floorRoot.transform.SetParent(transform, false);
            for (var x = 0; x < grid.ActiveWidth; x++)
            for (var y = 0; y < grid.ActiveHeight; y++)
            {
                var tile = MakeTile("Floor", new Vector2Int(x, y), new Vector3(1, .08f, 1), new Color(.96f, .91f, .78f));
                tile.transform.SetParent(floorRoot.transform, true);
            }
        }

        private void CreateWallsAndBoxes()
        {
            for (var x = 0; x < ArenaGrid.Width; x++)
            for (var y = 0; y < ArenaGrid.Height; y++)
            {
                var cell = new Vector2Int(x, y);
                var border = x == 0 || y == 0 || x == ArenaGrid.Width - 1 || y == ArenaGrid.Height - 1;
                var pillar = x % 2 == 0 && y % 2 == 0;
                if (border || pillar)
                {
                    grid.Set(cell, CellType.Solid, MakeTile("Pillar", cell, new Vector3(1, .9f, 1), new Color(.56f, .43f, .8f)));
                    continue;
                }
                if ((x + y * 3) % 4 == 0 && !IsSpawnSafe(cell))
                    grid.Set(cell, CellType.Soft, MakeTile("CloudBox", cell, new Vector3(.82f, .72f, .82f), new Color(1f, .72f, .43f)));
            }
        }

        private bool IsSpawnSafe(Vector2Int cell)
        {
            return cell.x <= 2 && cell.y <= 2 || cell.x >= ArenaGrid.Width - 3 && cell.y >= ArenaGrid.Height - 3;
        }

        private GameObject MakeTile(string label, Vector2Int cell, Vector3 scale, Color color)
        {
            var tile = GameObject.CreatePrimitive(PrimitiveType.Cube);
            tile.name = label;
            tile.transform.position = grid.ToWorld(cell) + Vector3.up * (scale.y * .5f);
            tile.transform.localScale = scale;
            tile.GetComponent<Renderer>().material.color = color;
            return tile;
        }

        private void CreatePlayer(string label, Vector2Int cell, KeyCode up, KeyCode down, KeyCode left, KeyCode right, KeyCode place, Color color)
        {
            var player = GameObject.CreatePrimitive(PrimitiveType.Capsule);
            player.name = label;
            localPlayers.Add(player);
            player.transform.position = grid.ToWorld(cell) + Vector3.up * .5f;
            player.GetComponent<Renderer>().material.color = color;
            var controller = player.AddComponent<GridPlayerController>();
            controller.Initialize(grid, cell, up, down, left, right, place);
        }

        private void SetupCamera()
        {
            var cameraObject = Camera.main != null ? Camera.main.gameObject : new GameObject("Main Camera", typeof(Camera));
            cameraObject.tag = "MainCamera";
            cameraObject.transform.position = new Vector3(0, 12, -10);
            cameraObject.transform.rotation = Quaternion.Euler(55, 0, 0);
            arenaCamera = cameraObject.GetComponent<Camera>();
            arenaCamera.orthographic = true;
            arenaCamera.orthographicSize = 7.5f;
        }

        private void FrameOnlineArena()
        {
            if (arenaCamera == null) SetupCamera();
            // Project the whole board and player height onto camera axes, including portrait screens.
            var focus = new Vector3(0, .75f, 0);
            arenaCamera.transform.position = focus - arenaCamera.transform.forward * 16f;
            var halfHorizontal = 0f;
            var halfVertical = 0f;
            for (var x = -1; x <= 1; x += 2)
            for (var z = -1; z <= 1; z += 2)
            for (var y = 0; y <= 2; y += 2)
            {
                var corner = new Vector3(x * grid.ActiveWidth * .5f, y, z * grid.ActiveHeight * .5f) - focus;
                halfHorizontal = Mathf.Max(halfHorizontal, Mathf.Abs(Vector3.Dot(corner, arenaCamera.transform.right)));
                halfVertical = Mathf.Max(halfVertical, Mathf.Abs(Vector3.Dot(corner, arenaCamera.transform.up)));
            }
            framedAspect = arenaCamera.aspect;
            arenaCamera.orthographicSize = Mathf.Max(halfVertical, halfHorizontal / Mathf.Max(.01f, framedAspect)) + .75f;
        }
    }
}
