"""Read-only public-snapshot planners shared by real-input browser acceptance.

These helpers never send commands or mutate a server/browser clock or state.
"""
DIRECTIONS = [('ArrowUp', 0, 1), ('ArrowRight', 1, 0),
              ('ArrowDown', 0, -1), ('ArrowLeft', -1, 0)]


def arena(state):
    value = state.get('arena') or {}
    pair = value.get('width'), value.get('height')
    return pair if pair in [(13, 11), (15, 13)] else (13, 11)


def center(state):
    width, height = arena(state)
    return width // 2, height // 2


def bases(state):
    width, _ = arena(state)
    return {'blue': (1, center(state)[1]), 'pink': (width - 2, center(state)[1])}


def assert_arena(state, expected=(15, 13)):
    assert state.get('arena') == dict(zip(('width', 'height'), expected)), state.get('arena')


def route(state, start, goal, avoid=()):
    width, height = arena(state)
    blocked = set(state['solid'] + state['soft']) | {
        f'{o["x"]},{o["y"]}' for o in state.get('orbs', [])} | {f'{x},{y}' for x, y in avoid}
    queue, seen = [(start, [])], {start}
    for (x, y), steps in queue:
        if (x, y) == goal:
            return steps
        for key, dx, dy in DIRECTIONS:
            cell = x + dx, y + dy
            if (not (0 < cell[0] < width - 1 and 0 < cell[1] < height - 1) or
                    cell in seen or f'{cell[0]},{cell[1]}' in blocked):
                continue
            seen.add(cell)
            queue.append((cell, steps + [(key, *cell)]))
    return None


def blast(state, origin, reach):
    width, height = arena(state)
    cells = {origin}
    for _, dx, dy in DIRECTIONS:
        for distance in range(1, reach + 1):
            x, y = origin[0] + distance * dx, origin[1] + distance * dy
            if not (0 < x < width - 1 and 0 < y < height - 1) or f'{x},{y}' in state['solid']:
                break
            cells.add((x, y))
            if f'{x},{y}' in state['soft']:
                break
    return cells


def rescue_plan(state, origin, reach=3):
    """Stage before the fuse, outside its real blast, at most two keys from rescue."""
    width, height = arena(state)
    danger = blast(state, origin, reach)
    occupied = set(state['solid'] + state['soft'])
    choices = []
    for x in range(1, width - 1):
        for y in range(1, height - 1):
            stage = x, y
            if stage in danger or f'{x},{y}' in occupied:
                continue
            for _, dx, dy in DIRECTIONS:
                goal = origin[0] + dx, origin[1] + dy
                steps = route(state, stage, goal, avoid=[origin])
                if steps and len(steps) <= 2:
                    choices.append((len(steps), abs(x-origin[0])+abs(y-origin[1]), stage, steps))
    assert choices, f'No safe rescue staging for {origin}'
    _, _, stage, steps = min(choices)
    return stage, steps


def crate_plan(state, start, reach=3):
    """Find a reachable real bomb site, breakable crate and two-key escape."""
    width, height = arena(state)
    choices = []
    soft = {tuple(map(int, cell.split(','))) for cell in state['soft']}
    for x in range(1, width - 1):
        for y in range(1, height - 1):
            origin = x, y
            incoming = route(state, start, origin)
            if incoming is None:
                continue
            crates = blast(state, origin, reach) & soft
            if not crates:
                continue
            for key, dx, dy in DIRECTIONS:
                first = x + dx, y + dy
                for key2, dx2, dy2 in DIRECTIONS:
                    final = first[0] + dx2, first[1] + dy2
                    escape = route(state, origin, final)
                    if escape is not None and len(escape) == 2 and final not in blast(state, origin, reach):
                        choices.append((len(incoming), origin, sorted(crates)[0], escape))
    assert choices, 'No reachable crate and two-move escape'
    _, origin, crate, escape = min(choices)
    return origin, crate, escape


def rescue_origin(state, preferred):
    """Keep the carrier near the star, choosing a real short safe rescue lane."""
    width, height = arena(state)
    cells = [(x, y) for x in range(1, width-1) for y in range(1, height-1)]
    cells.sort(key=lambda p: (abs(p[0]-preferred[0])+abs(p[1]-preferred[1]), p))
    for origin in cells:
        if route(state, preferred, origin) is None:
            continue
        try:
            stage, steps = rescue_plan(state, origin)
            return origin, stage, steps
        except AssertionError:
            continue
    raise AssertionError('No reachable short rescue lane')
