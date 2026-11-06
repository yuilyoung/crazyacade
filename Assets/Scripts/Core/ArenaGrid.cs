using System.Collections.Generic;
using UnityEngine;

namespace PopPopArena.Core
{
    public enum CellType { Empty, Solid, Soft, Orb }

    public sealed class ArenaGrid : MonoBehaviour
    {
        public const int Width = 13;
        public const int Height = 11;
        public const float CellSize = 1f;

        public int ActiveWidth { get; private set; } = Width;
        public int ActiveHeight { get; private set; } = Height;

        private readonly Dictionary<Vector2Int, CellType> cells = new();
        private readonly Dictionary<Vector2Int, GameObject> cellViews = new();

        public bool IsInside(Vector2Int cell) => cell.x >= 0 && cell.x < ActiveWidth && cell.y >= 0 && cell.y < ActiveHeight;
        public Vector3 ToWorld(Vector2Int cell) => new(cell.x - (ActiveWidth - 1) * .5f, 0, cell.y - (ActiveHeight - 1) * .5f);
        public CellType Get(Vector2Int cell) => cells.TryGetValue(cell, out var value) ? value : CellType.Empty;
        public bool CanWalk(Vector2Int cell) => IsInside(cell) && Get(cell) == CellType.Empty;

        // Only complete supported descriptors opt into the enlarged board.
        public bool ConfigureDimensions(int width, int height)
        {
            if (width != 15 || height != 13) { width = Width; height = Height; }
            if (ActiveWidth == width && ActiveHeight == height) return false;
            ClearAll();
            ActiveWidth = width;
            ActiveHeight = height;
            return true;
        }

        public void Set(Vector2Int cell, CellType type, GameObject view = null)
        {
            if (!IsInside(cell)) return;
            if (type == CellType.Empty) { Clear(cell); return; }
            if (cellViews.TryGetValue(cell, out var previous) && previous != view) ReleaseView(previous);
            cellViews.Remove(cell);
            cells[cell] = type;
            if (view != null) cellViews[cell] = view;
        }

        public void Clear(Vector2Int cell)
        {
            cells.Remove(cell);
            if (cellViews.Remove(cell, out var view)) ReleaseView(view);
        }

        public void ClearAll()
        {
            foreach (var view in cellViews.Values) ReleaseView(view);
            cellViews.Clear();
            cells.Clear();
        }

        private static void ReleaseView(GameObject view)
        {
            if (view == null) return;
            // Destroy is deferred; hide superseded geometry immediately.
            view.SetActive(false);
            Destroy(view);
        }

        public bool StopWave(Vector2Int cell)
        {
            if (Get(cell) == CellType.Solid) return true;
            if (Get(cell) == CellType.Soft)
            {
                Clear(cell);
                return true;
            }
            return false;
        }
    }
}
