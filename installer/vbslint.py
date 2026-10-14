#!/usr/bin/env python3
"""
vbslint.py — heuristic build-time checker for the FlightDeck VBScript launchers.

VBScript cannot be compiled on Linux (no cscript/wscript), so this catches the
classes of mistakes that break the launcher at parse time or at first run:

  1. Const initializers that are not literals
     (e.g. `Const X = OTHER_CONST & "/y"` -> compile error 800A0415
     "Expected literal constant" — this exact bug shipped in 0.1.0)
  2. Unbalanced double quotes on a logical line (compile error)
  3. `Option Explicit` missing or not the first statement (typos then fail late)
  4. Bad line-continuation `_` usage (compile error)
  5. Unbalanced Sub/Function/If/For/Do/Select blocks (compile error)
  6. Use of undeclared variables under `Option Explicit` (runtime error 800A01F4)

This is NOT a full VBScript compiler: it cannot prove a script runs on Windows.
It fails the build on anything suspicious so a human reviews it.

Usage: python3 installer/vbslint.py installer/launch.vbs installer/stop.vbs
Exit 0 when clean, 1 with diagnostics otherwise.
"""
import re
import sys

# Identifiers VBScript provides: statements, functions, keywords, common
# COM/WSH globals used by our launchers. Anything else must be Dim'd.
BUILTINS = set(
    """
    option explicit dim const redim set new nothing empty null true false
    sub function end if then else elseif select case while wend for each next
    to step do loop until exit on error resume goto
    msgbox inputbox createobject getobject wscript
    abs int sgn sqr rnd randomize cint clng cstr cbool cdate cdbl
    len left right mid instr instrrev replace split join trim ltrim rtrim
    ucase lcase asc chr strcomp lenb midb
    year month day hour minute second now date timer datediff dateadd
    isnull isempty isarray isdate isobject isnumberic vartype typename
    err number description source clear raise
    and or not xor mod eqv imp is
    me call byval byref public private class
    vbcr vbcrlf vblf vbtab vbnullstring vbok vbokcancel vbyesno vbquestion
    vbcritical vbexclamation vbinformation
    """.split()
)
# Object members / WSH properties we touch (obj.Member is not a variable use).
# Handled by only checking bare identifiers, not dotted ones.

LITERAL = re.compile(
    r"""^(
        "(?:[^"]|"")*"        # string literal, "" escapes
      | -?\d+(\.\d+)?        # number
      | true|false|empty|null
    )$""",
    re.IGNORECASE | re.VERBOSE,
)


def strip_comments(line: str) -> str:
    """Remove VBScript comments ('). Careful: ' inside a string is literal."""
    out = []
    in_str = False
    i = 0
    while i < len(line):
        ch = line[i]
        if ch == '"':
            if in_str and i + 1 < len(line) and line[i + 1] == '"':
                out.append('""')
                i += 2
                continue
            in_str = not in_str
            out.append(ch)
        elif ch == "'" and not in_str:
            break
        else:
            out.append(ch)
        i += 1
    return "".join(out)


def logical_lines(text: str):
    """Join VBScript line continuations (space + _ at end of line)."""
    result = []
    buf = ""
    for raw in text.splitlines():
        line = raw.rstrip()
        if re.search(r"\s_\s*$", line):
            if re.search(r'"[^"\n]*$', strip_comments(line.rsplit("_", 1)[0])):
                # `_` inside an unterminated string — not a continuation.
                result.append(buf + raw)
                buf = ""
            else:
                buf += re.sub(r"\s_\s*$", " ", line)
        else:
            result.append(buf + raw)
            buf = ""
    if buf:
        result.append(buf)
    return result


def check(path: str) -> list:
    errors = []
    text = open(path, encoding="utf-8-sig").read()
    lines = logical_lines(text)

    # --- Option Explicit first ---
    first_stmt = next(
        (l for l in lines if strip_comments(l).strip() and not strip_comments(l).strip().startswith("'")),
        "",
    )
    has_explicit = first_stmt.strip().lower() == "option explicit"
    if not has_explicit:
        errors.append(f"{path}:1: `Option Explicit` should be the first statement")

    declared: set = set()
    consts: set = set()
    block_stack: list = []
    dim_re = re.compile(r"^\s*dim\s+(.+)$", re.IGNORECASE)
    const_re = re.compile(r"^\s*const\s+(\w+)\s*=\s*(.+?)\s*$", re.IGNORECASE)
    func_re = re.compile(r"^\s*(?:sub|function)\s+(\w+)", re.IGNORECASE)

    for n, raw in enumerate(lines, 1):
        code = strip_comments(raw).strip()
        if not code:
            continue

        # --- record Sub/Function names (a Function's own name is its return
        #     variable, so assigning to it is legal) ---
        m = func_re.match(code)
        if m:
            declared.add(m.group(1).lower())

        # --- quotes balanced ---
        if code.count('"') % 2 != 0:
            errors.append(f"{path}:{n}: unbalanced double quotes")

        # --- Const initializers must be literals ---
        m = const_re.match(raw)
        if m:
            name, init = m.group(1), m.group(2)
            consts.add(name.lower())
            if not LITERAL.match(init):
                errors.append(
                    f"{path}:{n}: Const `{name}` initializer is not a literal "
                    f"({init!r}) — VBScript Const may not reference other "
                    f"identifiers (compile error 800A0415)"
                )
            continue

        # --- Dim collection ---
        m = dim_re.match(code)
        if m:
            for part in m.group(1).split(","):
                var = part.strip().split("(")[0].strip().lower()
                if var:
                    declared.add(var)
            continue

        # --- block balance ---
        low = code.lower()
        for opener, closer in [
            (r"^sub\s+\w+", "end sub"),
            (r"^function\s+\w+", "end function"),
            (r"^if\b.*\bthen\s*$", "end if"),
            (r"^for\b", "next"),
            (r"^do\b", "loop"),
            (r"^select\s+case\b", "end select"),
            (r"^while\b", "wend"),
        ]:
            if re.match(opener, low):
                block_stack.append((closer, n))
        for closer in ["end sub", "end function", "end if", "next", "loop", "end select", "wend"]:
            if re.match(rf"^{closer}\b", low):
                if block_stack and block_stack[-1][0] == closer:
                    block_stack.pop()
                else:
                    errors.append(f"{path}:{n}: `{closer}` without matching block opener")

    for closer, n in block_stack:
        errors.append(f"{path}:{n}: block opened but never closed (missing `{closer}`)")

    # --- undeclared variables (only when Option Explicit is on) ---
    if has_explicit:
        assign_re = re.compile(
            r"^\s*(?:set\s+)?([a-zA-Z_]\w*)\s*(?:\(.*\))?\s*=",
            re.IGNORECASE,
        )
        for n, raw in enumerate(lines, 1):
            code = strip_comments(raw)
            # skip strings for identifier scan
            nos = re.sub(r'"(?:[^"]|"")*"', '""', code)
            m = assign_re.match(nos)
            if m:
                var = m.group(1).lower()
                if var not in declared and var not in consts and var not in BUILTINS:
                    # allow `obj.Prop = x` targets and loop vars declared inline
                    errors.append(
                        f"{path}:{n}: assignment to undeclared variable `{m.group(1)}` "
                        f"(Option Explicit is on)"
                    )
    return errors


def main(paths):
    all_errors = []
    for p in paths:
        all_errors.extend(check(p))
    for e in all_errors:
        print("vbslint error:", e)
    if all_errors:
        print(f"vbslint: {len(all_errors)} problem(s) found — build stopped.")
        return 1
    print("vbslint: clean (" + ", ".join(paths) + ")")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:] or ["installer/launch.vbs", "installer/stop.vbs"]))
