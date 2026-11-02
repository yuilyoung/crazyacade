using PopPopArena.Core;
using UnityEngine;

namespace PopPopArena.Gameplay
{
    public enum PickupType { Orb, Wave, Dash, Pin }

    public sealed class Pickup : MonoBehaviour
    {
        [SerializeField] private PickupType type;
        public void Initialize(PickupType pickupType) => type = pickupType;
        public void Collect(GridPlayerController player)
        {
            player.ApplyPickup(type);
            Destroy(gameObject);
        }
    }

    public static class PickupSpawner
    {
        public static void TrySpawn(ArenaGrid grid, Vector2Int cell)
        {
            if (Random.value > .55f) return;
            var type = (PickupType)Random.Range(0, 4);
            var item = GameObject.CreatePrimitive(PrimitiveType.Sphere);
            item.name = type + " Pickup";
            item.transform.position = grid.ToWorld(cell) + Vector3.up * .28f;
            item.transform.localScale = Vector3.one * .35f;
            item.GetComponent<Collider>().isTrigger = true;
            item.GetComponent<Renderer>().material.color = type switch
            {
                PickupType.Orb => new Color(.3f, .9f, .85f),
                PickupType.Wave => new Color(1f, .75f, .25f),
                PickupType.Dash => new Color(.5f, .65f, 1f),
                _ => new Color(1f, .45f, .7f)
            };
            item.AddComponent<Pickup>().Initialize(type);
        }
    }
}
