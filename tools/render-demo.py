#!/usr/bin/env python3
"""
Render assets/demo.gif (English) and assets/demo.zh-CN.gif (Chinese).

This is a *simulated* render, not a screen recording: every frame is drawn with
Pillow from the timeline below. That keeps the asset reproducible and lets the
text stay exact. If you change the confirmation dialog or the hand-off note in
extensions/skill-autopilot/index.ts, update the strings here too.

Requirements: pillow, plus a monospace TTF and a CJK monospace font.

    python tools/render-demo.py --lang en
    python tools/render-demo.py --lang zh --out assets/demo.zh-CN.gif
"""

from __future__ import annotations

import argparse
import os
import sys

from PIL import Image, ImageDraw, ImageFont

# --------------------------------------------------------------------- canvas

W, H = 1000, 600
PAD_X, PAD_Y = 26, 22
LINE_H = 22
FONT_SIZE = 15

BG = (13, 17, 23)
TEXT = (201, 209, 217)
DIM = (125, 133, 144)
PROMPT = (88, 166, 255)
PLAN = (210, 168, 255)
GOOD = (63, 185, 80)
WARN = (210, 153, 34)
BORDER = (48, 54, 61)
BOXBGM = (22, 27, 34)

# (path, ttc index) — index 0 is fine for plain .ttf
MONO_LATIN = [(r"C:\Windows\Fonts\consola.ttf", 0)]
MONO_CJK = [
    (r"C:\Windows\Fonts\simsun.ttc", 1),  # NSimSun: half-width latin, full-width CJK
    (r"C:\Windows\Fonts\msyh.ttc", 0),
]


def load_font(lang: str, size: int = FONT_SIZE) -> ImageFont.FreeTypeFont:
    candidates = MONO_CJK if lang == "zh" else MONO_LATIN
    for path, index in candidates:
        if not os.path.exists(path):
            continue
        try:
            return ImageFont.truetype(path, size, index=index)
        except OSError:
            continue
    for name in ("DejaVuSansMono.ttf", "LiberationMono-Regular.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    print("No usable font found. Edit MONO_LATIN / MONO_CJK.", file=sys.stderr)
    raise SystemExit(1)


# ---------------------------------------------------------------------- copy

COPY = {
    "en": {
        "request": "Turn this ESG PDF into structured data, chart it, and write a Word summary",
        "planning": "▸ Planning…",
        "plan_header": "Plan:",
        "steps": [
            "Extract the emission tables from the PDF",
            "Build an Excel workbook with pivot tables",
            "Chart Scope 1/2/3 across years",
            "Write the Word report",
        ],
        "dialog_title": "Missing skills found — install and continue this turn?",
        "dialog_rows": [
            "  step 1 → pdf-tools v1.4.0 (relevance 8)",
            "  step 2 → excel-workbook v1.1.2 (relevance 12)",
            "  step 3 → chart-builder v2.0.0 (relevance 9)",
            "  step 4 → word-docx v1.0.2 (relevance 7)",
        ],
        "dialog_foot": [
            "  Rule: keyword relevance; installed and denied skills excluded",
            "  Enter install all      Esc skip",
        ],
        "confirmed": "✔ Confirmed — installing",
        "installing": "  Installing…",
        "handoff": "▸ Hand-off: step → SKILL.md path",
        "skills": ["pdf-tools", "excel-workbook", "chart-builder", "word-docx"],
        "resume": "▸ Resuming the plan: read step 1's SKILL.md, then extract the tables…",
        "staged": "staged · scan {level} · promoted",
        "levels": ["none", "low", "medium", "none"],
        "bullet": "▸ ",
        "check": "✔ ",
    },
    "zh": {
        "request": "把这个 ESG 报告 PDF 提取成结构化数据，做图表并输出 Word 汇总",
        "planning": "▸ 规划中…",
        "plan_header": "Plan:",
        "steps": [
            "读取 PDF 并提取排放数据表格",
            "整理成 Excel 工作簿并做透视表",
            "生成逐年 Scope 1/2/3 对比柱状图",
            "输出 Word 版汇报文档",
        ],
        "dialog_title": "检测到缺失的技能，安装后继续执行本轮任务？",
        "dialog_rows": [
            "  步骤 1 → pdf-tools v1.4.0（相关度 8）",
            "  步骤 2 → excel-workbook v1.1.2（相关度 12）",
            "  步骤 3 → chart-builder v2.0.0（相关度 9）",
            "  步骤 4 → word-docx v1.0.2（相关度 7）",
        ],
        "dialog_foot": [
            "  评估依据：关键词相关性，已排除已安装与策略禁止项",
            "  Enter 安装全部      Esc 跳过",
        ],
        "confirmed": "✔ 已确认，开始安装",
        "installing": "  安装中…",
        "handoff": "▸ 交接：步骤 → SKILL.md 绝对路径",
        "skills": ["pdf-tools", "excel-workbook", "chart-builder", "word-docx"],
        "resume": "▸ 继续执行计划：先 read 步骤 1 的 SKILL.md，再提取表格…",
        "staged": "已暂存 · 扫描 {level} · 已落地",
        "levels": ["无", "低", "中", "无"],
        "bullet": "· ",
        "check": "√ ",
    },
}


# ---------------------------------------------------------------- frame model


def build(lang: str) -> tuple[list[Image.Image], list[int]]:
    copy = COPY[lang]
    font = load_font(lang)
    font_bold = load_font(lang, FONT_SIZE + 1)

    frames: list[Image.Image] = []
    durations: list[int] = []
    lines: list[tuple[str, tuple[int, int, int], bool]] = []

    def render(dialog=None) -> Image.Image:
        img = Image.new("RGB", (W, H), BG)
        d = ImageDraw.Draw(img)
        y = PAD_Y
        for text, color, bold in lines:
            if y > H - PAD_Y - LINE_H:
                break
            d.text((PAD_X, y), text, font=font_bold if bold else font, fill=color)
            y += LINE_H
        if dialog:
            total = len(dialog) * LINE_H + 26
            bx = PAD_X
            by = H - total - PAD_Y
            d.rounded_rectangle(
                [bx, by, bx + W - 2 * PAD_X, by + total], radius=8, fill=BOXBGM, outline=BORDER, width=1
            )
            ty = by + 13
            for text, color, bold in dialog:
                d.text((bx + 14, ty), text, font=font_bold if bold else font, fill=color)
                ty += LINE_H
        return img

    def snap(delay: int, dialog=None) -> None:
        frames.append(render(dialog))
        durations.append(delay)

    def add(text="", color=TEXT, bold=False):
        lines.append((text, color, bold))

    def set_last(text, color=TEXT, bold=False):
        if lines:
            lines[-1] = (text, color, bold)
        else:
            add(text, color, bold)

    # ---- the request, typed --------------------------------------------
    snap(600)
    add()
    add("> ", PROMPT)
    text = copy["request"]
    for i in range(2, len(text) + 2, 2):
        set_last("> " + text[:i], PROMPT)
        snap(38)
    set_last("> " + text, PROMPT)
    snap(300)

    # ---- the plan --------------------------------------------------------
    add()
    add(copy["bullet"] + copy["planning"].lstrip("▸ "), DIM)
    snap(650)
    set_last(copy["plan_header"], PLAN, True)
    snap(240)
    for i, step in enumerate(copy["steps"], 1):
        add(f"  {i}. {step}", TEXT)
        snap(250)
    snap(450)

    # ---- the single batch confirmation ----------------------------------
    dialog = [(copy["dialog_title"], TEXT, True), ("", TEXT, False)]
    dialog += [(r, TEXT, False) for r in copy["dialog_rows"]]
    dialog += [("", TEXT, False)] + [(f, DIM, False) for f in copy["dialog_foot"]]
    snap(1100, dialog)

    confirmed = [list(r) for r in dialog]
    confirmed[0] = (copy["check"] + copy["confirmed"].lstrip("✔ "), GOOD, True)
    confirmed[-1] = ("", DIM, False)
    snap(380, [tuple(r) for r in confirmed])
    snap(220)

    # ---- staged install + scan ------------------------------------------
    add()
    add(copy["installing"], DIM)
    snap(280)
    for i, (skill, level) in enumerate(zip(copy["skills"], copy["levels"]), 1):
        head = f"  [{i}/4] {skill:<16}"
        set_last(head + "…", DIM)
        snap(200)
        color = WARN if level in ("medium", "中") else GOOD
        # one line per skill: promote the pending row instead of replacing the
        # previously finished one
        set_last(head + copy["staged"].format(level=level), color)
        snap(300)
        add()

    # ---- hand-off and resume --------------------------------------------
    add()
    add(copy["bullet"] + copy["handoff"].lstrip("▸ "), PLAN, True)
    snap(340)
    for i, skill in enumerate(copy["skills"], 1):
        label = "step" if lang == "en" else "步骤"
        add(f"  {label} {i} → ~/.pi/agent/skills/@acme/{skill}/SKILL.md", TEXT)
        snap(210)

    add()
    add(copy["bullet"] + copy["resume"].lstrip("▸ "), DIM)
    snap(1500)
    for _ in range(3):
        set_last(copy["bullet"] + copy["resume"].lstrip("▸ ") + "▌", DIM)
        snap(400)
        set_last(copy["bullet"] + copy["resume"].lstrip("▸ ") + " ", DIM)
        snap(400)

    return frames, durations


# ---------------------------------------------------------------------- save


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--lang", choices=["en", "zh"], default="en")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    out = args.out or ("assets/demo.zh-CN.gif" if args.lang == "zh" else "assets/demo.gif")
    frames, durations = build(args.lang)

    # Each frame is reduced to a small palette then expanded back to RGB.
    # Pillow 12 silently writes a single frame when append_images are P-mode,
    # so RGB frames are handed to the encoder; pre-reduction keeps the palette
    # (and the file) small.
    reduced = [im.quantize(colors=48, dither=Image.NONE).convert("RGB") for im in frames]

    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    reduced[0].save(
        out,
        save_all=True,
        append_images=reduced[1:],
        duration=durations,
        loop=0,
        optimize=True,
        disposal=1,
    )
    print(f"wrote {out}  frames={len(reduced)}  {os.path.getsize(out) / 1024:.0f} KB")


if __name__ == "__main__":
    main()
