using System.Collections;
using PopPopArena.Core;
using UnityEngine;

namespace PopPopArena.Gameplay
{
    public sealed class PopOrb : MonoBehaviour
    {
        private ArenaGrid grid;
        private Vector2Int origin;
        private int range;
        private bool popped;
        private GridPlayerController owner;

        public void Initialize(ArenaGrid arena, Vector2Int cell, int waveRange, GridPlayerController placedBy)
        {
            grid = arena; origin = cell; range = waveRange; owner = placedBy;
            StartCoroutine(Fuse());
        }

        private IEnumerator Fuse()
        {
            yield return new WaitForSeconds(2f);
            Pop();
        }

        public void Pop()
        {
            if (popped) return;
            popped = true;
            grid.Clear(origin);
            owner.RestoreOrbSlot();
            Affect(origin);
            Spread(Vector2Int.up); Spread(Vector2Int.down); Spread(Vector2Int.left); Spread(Vector2Int.right);
            Destroy(gameObject);
        }

        private void Spread(Vector2Int direction)
        {
            for (var i = 1; i <= range; i++)
            {
                var cell = origin + direction * i;
                if (!grid.IsInside(cell) || grid.Get(cell) == CellType.Solid) break;
                if (grid.Get(cell) == CellType.Soft)
                {
                    grid.Clear(cell);
                    PickupSpawner.TrySpawn(grid, cell);
                    break;
                }
                Affect(cell);
            }
        }

        private void Affect(Vector2Int cell)
        {
            var wave = GameObject.CreatePrimitive(PrimitiveType.Cube);
            wave.name = "PopWave";
            wave.transform.position = grid.ToWorld(cell) + Vector3.up * .12f;
            wave.transform.localScale = new Vector3(.86f, .2f, .86f);
            wave.GetComponent<Renderer>().material.color = new Color(1f, .9f, .25f);
            Destroy(wave, .35f);

            foreach (var hit in Physics.OverlapSphere(grid.ToWorld(cell) + Vector3.up * .5f, .42f))
            {
                if (hit.TryGetComponent<PopOrb>(out var chained)) chained.Pop();
                if (hit.TryGetComponent<GridPlayerController>(out var player)) player.HitByWave();
            }
        }
    }
}
