"""A/B frame-timing probe for sidebar & now-playing panel toggles (warmed up, median of runs)."""
import json
import statistics
from playwright.sync_api import sync_playwright

URL = 'http://localhost:4173'

FRAME_JS = """
() => {
  window.__frames = [];
  window.__last = performance.now();
  window.__rec = true;
  const loop = (t) => {
    if (!window.__rec) return;
    window.__frames.push(t - window.__last);
    window.__last = t;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
"""

STOP_JS = "() => { window.__rec = false; return window.__frames.slice(2); }"


def run_set(page, sel):
    el = page.locator(sel).first
    # warmup: two full open/close cycles (JIT, style caches, image decodes)
    for _ in range(2):
        el.click(); page.wait_for_timeout(650)
        el.click(); page.wait_for_timeout(650)
    out = []
    for _ in range(3):
        for _ in range(2):  # one measured open + close per run
            page.evaluate(FRAME_JS)
            el.click()
            page.wait_for_timeout(700)
            out.append(page.evaluate(STOP_JS))
            page.wait_for_timeout(300)
    # per-run stats -> median across runs
    runs = []
    for frames in out:
        runs.append({
            'avg': round(sum(frames) / len(frames), 1),
            'max': round(max(frames), 1),
            'long': len([f for f in frames if f > 25]),
        })
    med = {
        'avg_med_ms': statistics.median(r['avg'] for r in runs),
        'max_med_ms': statistics.median(r['max'] for r in runs),
        'long_med': statistics.median(r['long'] for r in runs),
        'frames_per_run_med': statistics.median(len(f) for f in out),
    }
    return med


with sync_playwright() as p:
    browser = p.chromium.launch(headless=False)
    page = browser.new_page(viewport={'width': 1440, 'height': 900})
    page.goto(URL)
    page.wait_for_load_state('networkidle')
    page.wait_for_timeout(2000)
    res = {}
    res['sidebar'] = run_set(page, '.brand-toggle > button')
    res['np_panel'] = run_set(page, '.mini-right button.ib-toggle')
    print('RESULTS', json.dumps(res, indent=1))
    browser.close()
