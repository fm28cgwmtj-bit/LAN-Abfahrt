"""Optionaler Chromium-Browsertest für den Handy-Zoomschutz (Python-Paket playwright)."""

import argparse
import json
import time
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright


NAME = "Zoom-Test"


def empty_test_lobby(page, url):
    # Den Raum vor dem Beitritt nur beobachten. Ein eigener Offline-Eintrag darf vom letzten Test stammen.
    room = {}

    def receive(frame):
        if isinstance(frame, str) and frame.startswith(('42["state",', '42["meta",')):
            event, data = json.loads(frame[2:])
            room[event] = data

    page.on("websocket", lambda ws: ws.on("framereceived", receive))
    page.goto(url)
    deadline = time.monotonic() + 10
    while len(room) < 2 and time.monotonic() < deadline:
        page.wait_for_timeout(50)
    if room.get("state", {}).get("phase") != "lobby" or "meta" not in room:
        raise RuntimeError("Keine freie LAN-Abfahrt-Testlobby erreicht.")
    if any(p["connected"] or p["name"] != NAME for p in room["meta"]["players"]):
        raise RuntimeError("Die Testlobby enthält bereits Spieler.")


def gesture(cdp, start, end):
    """Tatsächliche Touchkontakte über Chromiums Debugging-Protokoll bewegen."""
    for step in range(19):
        progress = step / 18
        points = []
        for finger, ((x, y), (tx, ty)) in enumerate(zip(start, end), start=1):
            points.append({"id": finger, "x": x + (tx - x) * progress, "y": y + (ty - y) * progress})
        event = "touchMove" if step else "touchStart"
        cdp.send("Input.dispatchTouchEvent", {"type": event, "touchPoints": points})
        time.sleep(0.016)
    cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})


def spread(cdp, y):
    gesture(cdp, [(140, y), (180, y)], [(40, y), (280, y)])


def check(page, cdp, url):
    page.set_content('<meta name="viewport" content="width=device-width,initial-scale=1">'
                     '<main style="height:200vh">Zoom-Kontrollseite</main>')
    spread(cdp, 160)
    page.wait_for_function("visualViewport.scale > 1.5")
    empty_test_lobby(page, url)

    page.get_by_placeholder("z. B. Marlon").fill(NAME)
    page.get_by_role("button", name="Los geht's!").tap()
    add_bot = page.get_by_role("button", name="+ Bot", exact=True)
    try:
        for _ in range(2):
            add_bot.tap()
        page.get_by_role("button", name="Arcade", exact=True).tap()
        page.locator(".arcade-tile").filter(has_text="Lügen-Lexikon").tap()
        page.locator(".it-ready").tap()

        field = page.get_by_placeholder("Deine Lüge ...")
        field.fill("Ein kleines Messingrad")
        # Chromium unterbindet Pinch im Vollbild selbst. Im normalen Browser muss das Textfeld zoomfähig sein.
        page.evaluate("async () => { if (document.fullscreenElement) await document.exitFullscreen(); }")
        field.focus()
        box = field.bounding_box()
        spread(cdp, box["y"] + box["height"] / 2)
        page.wait_for_function("visualViewport.scale > 1.5")
        expect(page.locator("#zoom-help")).to_be_hidden()
        field.press("Enter")

        reset = page.get_by_role("button", name="Zoom zurücksetzen")
        expect(reset).to_be_visible()
        # CDP erwartet CSS-Pixel bezogen auf den sichtbaren Ausschnitt der gezoomten Seite.
        x, y = reset.evaluate("""el => {
            const r = el.getBoundingClientRect(), v = visualViewport;
            return [r.x + r.width / 2 - v.offsetLeft, r.y + r.height / 2 - v.offsetTop];
        }""")
        page.touchscreen.tap(x, y)
        page.wait_for_function("!document.querySelector('#zoom-help').open && visualViewport.scale <= 1.01")

        answers = page.locator(".lx-opts")
        expect(answers).to_be_visible(timeout=25000)
        page.wait_for_function("""() => {
            const app = document.querySelector('#app');
            return app.scrollHeight > app.clientHeight + 15;
        }""")
        spread(cdp, 170)
        expect(page.locator("#zoom-help")).to_be_hidden()
        if abs(page.evaluate("visualViewport.scale") - 1) >= 0.01:
            raise AssertionError("Pinch vergrößert die Antwortliste")
        gesture(cdp, [(150, 340)], [(150, 130)])
        page.wait_for_function("document.querySelector('#app').scrollTop > 15")
        answers.locator("button:not(:disabled)").last.tap()
        expect(page.get_by_role("heading", name="Schau auf den Fernseher!")).to_be_visible(timeout=25000)
    finally:
        if page.locator("#zoom-help[open]").count():
            page.keyboard.press("Escape")
        abort = page.locator("button.abort")
        if abort.is_visible():
            page.once("dialog", lambda dialog: dialog.accept())
            abort.press("Enter")
        page.get_by_role("button", name="Bots entfernen", exact=True).tap()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", required=True, help="Leere lokale Testinstanz, z. B. http://127.0.0.1:4100")
    parser.add_argument("--chromium", help="Pfad zu lokalem Chromium (Standard: Playwright-Chromium)")
    args = parser.parse_args()
    target = urlsplit(args.url)
    if target.scheme not in ("http", "https") or target.hostname not in ("127.0.0.1", "::1", "localhost"):
        parser.error("--url muss auf eine lokale Testinstanz zeigen.")
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=args.chromium)
        phone = browser.new_context(viewport={"width": 320, "height": 390}, is_mobile=True, has_touch=True)
        page = phone.new_page()
        check(page, phone.new_cdp_session(page), args.url)
        browser.close()
    print("Handy-Zoom geprüft: Kontrollseite, Texteingabe, Zoomhilfe, gesperrtes Spiel und scrollbare Abstimmung.")


if __name__ == "__main__":
    main()
