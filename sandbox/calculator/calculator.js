(function () {
  "use strict";

  const historyEl = document.getElementById("history");
  const currentEl = document.getElementById("current");
  const historyToggleEl = document.getElementById("history-toggle");
  const historyPanelEl = document.getElementById("history-panel");
  const historyListEl = document.getElementById("history-list");
  const historyEmptyEl = document.getElementById("history-empty");
  const historyClearEl = document.getElementById("history-clear");

  const MAX_HISTORY = 20;

  const state = {
    current: "0",   // what the user is typing
    previous: null, // stored left-hand operand (number)
    op: null,       // pending operator
    justEvaluated: false,
  };

  // Past calculations, newest first: { expression, result }
  const history = [];

  const OP_SYMBOLS = { "+": "+", "-": "−", "*": "×", "/": "÷" };

  function compute(a, b, op) {
    switch (op) {
      case "+": return a + b;
      case "-": return a - b;
      case "*": return a * b;
      case "/": return b === 0 ? NaN : a / b;
      default: return b;
    }
  }

  function format(value) {
    if (!isFinite(value)) return "Error";
    // Keep precision reasonable, drop trailing zeros.
    const rounded = parseFloat(value.toPrecision(12));
    return String(rounded);
  }

  function render() {
    currentEl.textContent = state.current;
    historyEl.textContent =
      state.previous !== null && state.op
        ? `${format(state.previous)} ${OP_SYMBOLS[state.op]}`
        : "";
  }

  function inputDigit(digit) {
    if (state.justEvaluated) {
      state.current = digit;
      state.justEvaluated = false;
      return;
    }
    state.current = state.current === "0" ? digit : state.current + digit;
  }

  function inputDecimal() {
    if (state.justEvaluated) {
      state.current = "0.";
      state.justEvaluated = false;
      return;
    }
    if (!state.current.includes(".")) state.current += ".";
  }

  function chooseOperator(op) {
    const value = parseFloat(state.current);
    if (Number.isNaN(value)) return;

    if (state.previous !== null && state.op && !state.justEvaluated) {
      const result = compute(state.previous, value, state.op);
      state.previous = result;
      state.current = format(result);
    } else {
      state.previous = value;
    }

    state.op = op;
    state.current = format(state.previous);
    // Showing the running total; the next digit starts a fresh entry.
    state.justEvaluated = true;
  }

  function equals() {
    if (state.previous === null || !state.op) return;
    const value = parseFloat(state.current);
    const result = compute(state.previous, value, state.op);
    const expression = `${format(state.previous)} ${OP_SYMBOLS[state.op]} ${format(value)}`;

    state.current = format(result);
    state.previous = null;
    state.op = null;
    state.justEvaluated = true;

    addHistoryEntry(expression, state.current);
  }

  function addHistoryEntry(expression, result) {
    history.unshift({ expression, result });
    if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
    renderHistoryPanel();
  }

  function renderHistoryPanel() {
    historyListEl.textContent = "";

    for (const entry of history) {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "history-entry";
      button.dataset.result = entry.result;
      button.title = `Use ${entry.result}`;

      const expr = document.createElement("span");
      expr.className = "expr";
      expr.textContent = `${entry.expression} =`;

      const res = document.createElement("span");
      res.className = "result";
      res.textContent = entry.result;

      button.append(expr, res);
      item.append(button);
      historyListEl.append(item);
    }

    historyEmptyEl.hidden = history.length > 0;
  }

  function setHistoryPanelOpen(open) {
    historyPanelEl.hidden = !open;
    historyToggleEl.setAttribute("aria-expanded", String(open));
  }

  function recallResult(result) {
    if (result === "Error") return;
    state.current = result;
    // Keep any pending operator so "12 + <recalled>" still works.
    state.justEvaluated = false;
    render();
  }

  function clearAll() {
    state.current = "0";
    state.previous = null;
    state.op = null;
    state.justEvaluated = false;
  }

  function toggleSign() {
    if (state.current === "0" || state.current === "Error") return;
    state.current = state.current.startsWith("-")
      ? state.current.slice(1)
      : "-" + state.current;
  }

  function percent() {
    const value = parseFloat(state.current);
    if (Number.isNaN(value)) return;
    state.current = format(value / 100);
  }

  function handleAction(action) {
    switch (action) {
      case "clear": clearAll(); break;
      case "sign": toggleSign(); break;
      case "percent": percent(); break;
      case "decimal": inputDecimal(); break;
      case "equals": equals(); break;
    }
  }

  document.querySelector(".keys").addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;

    if (button.dataset.digit !== undefined) inputDigit(button.dataset.digit);
    else if (button.dataset.op) chooseOperator(button.dataset.op);
    else if (button.dataset.action) handleAction(button.dataset.action);

    render();
  });

  historyToggleEl.addEventListener("click", () => {
    setHistoryPanelOpen(historyPanelEl.hidden);
  });

  historyListEl.addEventListener("click", (event) => {
    const entry = event.target.closest(".history-entry");
    if (!entry) return;
    recallResult(entry.dataset.result);
    setHistoryPanelOpen(false);
  });

  historyClearEl.addEventListener("click", () => {
    history.length = 0;
    renderHistoryPanel();
  });

  document.addEventListener("keydown", (event) => {
    const key = event.key;

    if (key === "Escape" && !historyPanelEl.hidden) {
      setHistoryPanelOpen(false);
      return;
    }

    if (key >= "0" && key <= "9") inputDigit(key);
    else if (key === ".") inputDecimal();
    else if (["+", "-", "*", "/"].includes(key)) chooseOperator(key);
    else if (key === "Enter" || key === "=") { event.preventDefault(); equals(); }
    else if (key === "Escape") clearAll();
    else if (key === "Backspace") {
      state.current =
        state.current.length > 1 ? state.current.slice(0, -1) : "0";
    } else return;

    render();
  });

  renderHistoryPanel();
  render();
})();
