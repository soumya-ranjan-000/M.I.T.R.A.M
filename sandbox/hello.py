import os
import sys
from functools import reduce

OPERATIONS = {
    "1": ("Add", "+", lambda a, b: a + b),
    "2": ("Subtract", "-", lambda a, b: a - b),
    "3": ("Multiply", "*", lambda a, b: a * b),
    "4": ("Divide", "/", lambda a, b: a / b),
}

WIDTH = 42

# Colours are disabled when piping output or when NO_COLOR is set.
USE_COLOR = sys.stdout.isatty() and "NO_COLOR" not in os.environ


def paint(text, *codes):
    """Wrap text in ANSI codes, or return it unchanged if colour is off."""
    if not USE_COLOR or not codes:
        return text
    return "\033[" + ";".join(codes) + "m" + text + "\033[0m"


BOLD, DIM, CYAN, GREEN, YELLOW, RED = "1", "2", "36", "32", "33", "31"


def box_top():
    print(paint("╭" + "─" * (WIDTH - 2) + "╮", DIM, CYAN))


def box_bottom():
    print(paint("╰" + "─" * (WIDTH - 2) + "╯", DIM, CYAN))


def box_sep():
    print(paint("├" + "─" * (WIDTH - 2) + "┤", DIM, CYAN))


def box_row(text="", *codes, align="<"):
    """Print one framed row; padding is measured on the uncoloured text."""
    pad = WIDTH - 4 - len(text)
    if align == "^":
        left, right = pad // 2, pad - pad // 2
    else:
        left, right = 0, pad
    bar = paint("│", DIM, CYAN)
    print(f"{bar} {' ' * left}{paint(text, *codes)}{' ' * right} {bar}")


def notice(text, *codes):
    print("  " + paint(text, *codes))


def wrap_expression(expression, limit=WIDTH - 4):
    """Split a long "a + b + c" expression across several lines."""
    lines, current = [], ""
    for token in expression.split(" "):
        candidate = f"{current} {token}".strip()
        if len(candidate) > limit and current:
            lines.append(current)
            current = token
        else:
            current = candidate
    if current:
        lines.append(current)
    return lines


def read_number(prompt, allow_blank=False):
    """Keep asking until the user types a valid number.

    Returns None if allow_blank is True and the user just presses Enter.
    """
    while True:
        raw = input(paint("  " + prompt, CYAN)).strip()
        if allow_blank and not raw:
            return None
        try:
            return float(raw)
        except ValueError:
            notice("✖ Please enter a valid number.", RED)


def read_numbers(min_count=2):
    """Read numbers one per line; a blank line ends the list."""
    numbers = []
    notice(f"Enter at least {min_count} numbers, blank line to finish.", DIM)
    while True:
        index = len(numbers) + 1
        label = f"#{index}".rjust(3)
        if len(numbers) < min_count:
            value = read_number(f"{label} › ")
        else:
            value = read_number(f"{label} › ", allow_blank=True)
            if value is None:
                return numbers
        numbers.append(value)


def main():
    print()
    box_top()
    box_row("SIMPLE CALCULATOR", BOLD, CYAN, align="^")
    box_sep()
    for key, (name, symbol, _) in OPERATIONS.items():
        box_row(f"{key}  {name:<10} {symbol}")
    box_row(f"{'q':>1}  {'Quit':<10}")
    box_bottom()

    while True:
        choice = input("\n" + paint("  Choose an option › ", BOLD)).strip().lower()

        if choice == "q":
            notice("👋 Goodbye!", BOLD, CYAN)
            break

        if choice not in OPERATIONS:
            notice("✖ Invalid choice, try 1-4 or q.", RED)
            continue

        name, symbol, func = OPERATIONS[choice]
        notice(f"▸ {name}", BOLD, YELLOW)
        numbers = read_numbers()

        if choice == "4" and any(n == 0 for n in numbers[1:]):
            notice("✖ Cannot divide by zero.", RED)
            continue

        result = reduce(func, numbers)
        expression = f" {symbol} ".join(f"{n:g}" for n in numbers)
        print()
        box_top()
        for line in wrap_expression(expression):
            box_row(line)
        box_sep()
        box_row(f"= {result:g}", BOLD, GREEN)
        box_bottom()


if __name__ == "__main__":
    main()
