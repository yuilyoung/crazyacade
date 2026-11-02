using PopPopArena.Core;
using PopPopArena.Networking;
using UnityEngine;

namespace PopPopArena.Gameplay
{
    public sealed class GridPlayerController : MonoBehaviour
    {
        private ArenaGrid grid;
        private Vector2Int cell;
        private KeyCode up, down, left, right, place;
        private bool moving;
        private Vector3 target;
        private int maxOrbs = 1;
        private int placedOrbs;
        private int waveRange = 3;
        private float moveSpeed = 7f;
        private bool bubbled;
        private bool eliminated;

        public Vector2Int Cell => cell;
        public bool IsBubbled => bubbled;
        public bool IsEliminated => eliminated;

        public void Initialize(ArenaGrid arena, Vector2Int start, KeyCode upKey, KeyCode downKey, KeyCode leftKey, KeyCode rightKey, KeyCode placeKey)
        {
            grid = arena; cell = start; up = upKey; down = downKey; left = leftKey; right = rightKey; place = placeKey;
            MatchDirector.Instance.Register(this);
        }

        private void Update()
        {
            if (OnlineInputRouter.IsOnline) return;
            if (OnlineInputRouter.WasDisconnected || eliminated || !MatchDirector.Instance.CanPlay) return;
            if (moving)
            {
                transform.position = Vector3.MoveTowards(transform.position, target, moveSpeed * Time.deltaTime);
                moving = Vector3.Distance(transform.position, target) > .01f;
                if (!moving) CollectPickup();
                return;
            }
            if (bubbled) return;
            if (Input.GetKeyDown(place)) SendOrPlace("place_orb", Vector2Int.zero);
            if (Input.GetKeyDown(up)) SendOrPlace("up", Vector2Int.up);
            else if (Input.GetKeyDown(down)) SendOrPlace("down", Vector2Int.down);
            else if (Input.GetKeyDown(left)) SendOrPlace("left", Vector2Int.left);
            else if (Input.GetKeyDown(right)) SendOrPlace("right", Vector2Int.right);
        }

        public void TryMove(Vector2Int direction)
        {
            var next = cell + direction;
            if (!grid.CanWalk(next)) return;
            cell = next; target = grid.ToWorld(cell) + Vector3.up * .5f; moving = true;
        }

        public void TryPlaceOrb()
        {
            if (bubbled || placedOrbs >= maxOrbs || grid.Get(cell) != CellType.Empty) return;
            var orb = GameObject.CreatePrimitive(PrimitiveType.Sphere);
            orb.name = "PopOrb";
            orb.transform.position = grid.ToWorld(cell) + Vector3.up * .3f;
            orb.transform.localScale = Vector3.one * .58f;
            orb.GetComponent<Renderer>().material.color = new Color(.4f, 1f, .8f);
            grid.Set(cell, CellType.Orb, orb);
            placedOrbs++;
            orb.AddComponent<PopOrb>().Initialize(grid, cell, waveRange, this);
        }

        private void SendOrPlace(string action, Vector2Int direction)
        {
            if (OnlineInputRouter.TrySend(action)) return;
            if (action == "place_orb") TryPlaceOrb(); else TryMove(direction);
        }

        public void RestoreOrbSlot() => placedOrbs = Mathf.Max(0, placedOrbs - 1);

        public void ApplyPickup(PickupType type)
        {
            switch (type)
            {
                case PickupType.Orb: maxOrbs = Mathf.Min(maxOrbs + 1, 5); break;
                case PickupType.Wave: waveRange = Mathf.Min(waveRange + 1, 7); break;
                case PickupType.Dash: moveSpeed = Mathf.Min(moveSpeed + 1.25f, 12f); break;
                case PickupType.Pin: Rescue(); break;
            }
        }

        public void HitByWave()
        {
            if (eliminated || bubbled) return;
            bubbled = true;
            GetComponent<Renderer>().material.color = Color.white;
            MatchDirector.Instance.BeginBubbleCountdown(this);
        }

        public void Rescue()
        {
            if (!bubbled || eliminated) return;
            bubbled = false;
            GetComponent<Renderer>().material.color = name == "P1" ? new Color(.35f, .8f, 1f) : new Color(1f, .5f, .75f);
        }

        public void Eliminate()
        {
            if (eliminated) return;
            eliminated = true;
            gameObject.SetActive(false);
            MatchDirector.Instance.EvaluateWinner();
        }

        private void CollectPickup()
        {
            foreach (var hit in Physics.OverlapSphere(grid.ToWorld(cell) + Vector3.up * .25f, .38f))
                if (hit.TryGetComponent<Pickup>(out var pickup)) pickup.Collect(this);
            MatchDirector.Instance.TryRescueBy(this);
        }
    }
}
