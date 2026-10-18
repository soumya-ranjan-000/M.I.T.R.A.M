# Plan: Web UI for the Calculator

## Current state
`hello.py` mixes calculation logic with terminal I/O (`input()`/`print()`,
box-drawing). To serve a web UI, the logic will be extracted into a pure
module and exposed via a small local web server.

## Approach: Flask backend + HTML/CSS/JS frontend

- [ ] **`calc_core.py`** (new) — pure logic, no I/O, shared by CLI and web
  - [ ] Move `OPERATIONS` table + calculation logic out of `hello.py`
  - [ ] `calculate(op_key, numbers) -> float`, raising a `CalcError` (new
        exception with a friendly `.message`) on divide-by-zero or bad
        input — no printing, just exceptions
  - [ ] Update `hello.py` to import from here so the terminal app keeps
        working unchanged

- [ ] **`app.py`** (new) — Flask server
  - [ ] `GET /` → renders `templates/index.html` (the calculator page)
  - [ ] `POST /api/calculate` → accepts JSON `{"op": "1", "numbers": [1,2,3]}`,
        calls `calc_core.calculate`, returns `{"result": ...}` or
        `{"error": "..."}` with proper status code
  - [ ] `pip install flask` (only new dependency)

- [ ] **`templates/index.html`** (new) — simple calculator layout: display
      screen, number pad, operator buttons, `=`, `C`, `⌫`, matching the
      existing dark/boxed aesthetic (CYAN/GREEN/RED accents) as a nod to the
      terminal version's style

- [ ] **`static/script.js`** (new) — client-side logic
  - [ ] Builds up the expression as the user clicks digits/operators (or
        types on keyboard — bind keydown)
  - [ ] On `=`, sends the current numbers/operator to `/api/calculate` via
        `fetch`, displays result or error
  - [ ] Handles `C`/backspace/keyboard shortcuts (Enter = `=`, Esc = clear)

- [ ] **`static/style.css`** (new) — grid layout for buttons, responsive
      sizing, color scheme matching the CLI (dark background, cyan borders,
      green result, red errors)

- [ ] **`test_calc_core.py`** (new, pytest) — unit tests for `calculate()`:
      each op, divide-by-zero, independent of Flask

- [ ] **README.md** — add a "Web UI" section: `pip install flask`,
      `python app.py`, open `http://127.0.0.1:5000`

## File layout
```
calc_core.py
app.py
templates/index.html
static/style.css
static/script.js
test_calc_core.py
hello.py        (updated to use calc_core)
README.md       (updated)
```

## Verification
- [ ] `pytest test_calc_core.py -v` — all pass
- [ ] `python hello.py` still works unchanged (regression check)
- [ ] `python app.py`, then manually test in a browser: basic
      add/subtract/multiply/divide, divide-by-zero shows an error, keyboard
      input works, clear/backspace work
- [ ] `get_diagnostics` on all new/changed files
