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

        private readonly Dictionary<Vector2Int, CellType> cells = new();
        private readonly Dictionary<Vector2Int, GameObject> cellViews = new();

        public bool IsInside(Vector2Int cell) => cell.x >= 0 && cell.x < Width && cell.y >= 0 && cell.y < Height;
        public Vector3 ToWorld(Vector2Int cell) => new(cell.x - (Width - 1) * .5f, 0, cell.y - (Height - 1) * .5f);
        public CellType Get(Vector2Int cell) => cells.TryGetValue(cell, out var value) ? value : CellType.Empty;
        public bool CanWalk(Vector2Int cell) => IsInside(cell) && Get(cell) == CellType.Empty;

        public void Set(Vector2Int cell, CellType type, GameObject view = null)
        {
            cells[cell] = type;
            if (view != null) cellViews[cell] = view;
        }

        public void Clear(Vector2Int cell)
        {
            cells[cell] = CellType.Empty;
            if (cellViews.Remove(cell, out var view) && view != null) Destroy(view);
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
