import os
import sys
from PIL import Image, ImageDraw, ImageFont, ImageFilter

# 用法：python scripts/generate_showcase.py <原截图路径>
# 本机绝对路径一律走参数/环境变量，不写死进仓库。
SRC = (sys.argv[1] if len(sys.argv) > 1 else os.environ.get("SHOWCASE_SRC", "")).strip()
if not SRC:
    raise SystemExit("请传入原截图路径：python scripts/generate_showcase.py <原截图.png>")
BG = (249, 250, 251)

orig = Image.open(SRC).convert('RGB')
W, H = orig.size  # 1400 x 979

os.makedirs('assets', exist_ok=True)

# ---- 1. 清理侧边栏：去掉红色手绘箭头（含淡粉色虚线残留）与深色 tooltip ----
sidebar = orig.crop((0, 0, 626, H)).copy()
spix = sidebar.load()
for y in range(sidebar.height):
    for x in range(sidebar.width):
        r, g, b = spix[x, y]
        # 红色系：放宽阈值，覆盖饱和红 (250,81,81) 与淡粉虚线描边
        if r > 150 and (r - g) > 12 and (r - b) > 12:
            spix[x, y] = BG
        # 深色 tooltip 卡片底
        elif x > 340 and r < 80 and g < 80 and b < 80:
            spix[x, y] = BG
# tooltip 矩形区整体重建：原图 x401~889 / y535~799 落在侧边栏内的部分。
# pill 行在 x<401 处残留半截标题文字，与右侧重铺底色形成“拦腰截断”。
# 干脆整行重绘：全行铺底色后画一个干净圆角 pill + 重写标题，一劳永逸。
PILL = (236, 238, 240)
for y in range(530, 806):
    for x in range(401, sidebar.width):
        if 540 <= y <= 607:
            spix[x, y] = PILL
        else:
            spix[x, y] = BG
# 整条 pill 行重绘（去掉被 tooltip 压住的半截字）
for y in range(540, 608):
    for x in range(sidebar.width):
        spix[x, y] = BG
_pill = ImageDraw.Draw(sidebar)
_pill.rounded_rectangle([40, 546, 590, 602], radius=14, fill=PILL)
try:
    _font_pill = ImageFont.truetype(r'C:\Windows\Fonts\msyh.ttc', 26)
    _font_pill_small = ImageFont.truetype(r'C:\Windows\Fonts\msyh.ttc', 20)
except Exception:
    _font_pill = ImageFont.load_default()
    _font_pill_small = _font_pill
_pill.text((110, 556), "Web 文件浏览添加缩略图预览", fill=(30, 41, 59),
           font=_font_pill_small)

# ---- 2. 画布与字体：右侧无卡片，大标题 + 一行精简小字 ----
font_title = ImageFont.truetype(r'C:\Windows\Fonts\msyhbd.ttc', 34)
font_subtitle = ImageFont.truetype(r'C:\Windows\Fonts\msyh.ttc', 19)
font_tag = ImageFont.truetype(r'C:\Windows\Fonts\msyhbd.ttc', 13)
font_big = ImageFont.truetype(r'C:\Windows\Fonts\msyhbd.ttc', 34)
font_num = ImageFont.truetype(r'C:\Windows\Fonts\msyhbd.ttc', 20)
font_desc = ImageFont.truetype(r'C:\Windows\Fonts\msyh.ttc', 19)

canvas_w, canvas_h = 1600, 1060
bg = Image.new('RGBA', (canvas_w, canvas_h), (245, 247, 250, 255))
draw = ImageDraw.Draw(bg)

# 背景纵向微渐变
for y in range(canvas_h):
    ratio = y / canvas_h
    r = int(248 * (1 - ratio) + 238 * ratio)
    g = int(250 * (1 - ratio) + 242 * ratio)
    b = int(252 * (1 - ratio) + 248 * ratio)
    draw.line([(0, y), (canvas_w, y)], fill=(r, g, b, 255))

# 顶部标题
draw.text((70, 42), "DeepSeek Harness · 远程 SSH 实例与工作区聚合",
          fill=(15, 23, 42, 255), font=font_title)
draw.text((70, 92), "零界面侵入 · 免密主机即点即连 · 实时双向流式对话 · 远程提问卡片无缝闭环",
          fill=(100, 116, 139, 255), font=font_subtitle)

# ---- 3. 左侧窗口（裁到 800 高，避免文字拦腰截断） ----
win_x, win_y = 70, 146
win_w = 626
SB_H = 800
TITLEBAR = 40
win_h = SB_H + TITLEBAR + 8
sb_crop = sidebar.crop((0, 0, win_w, SB_H))

shadow = Image.new('RGBA', (win_w + 60, win_h + 60), (0, 0, 0, 0))
sdraw = ImageDraw.Draw(shadow)
sdraw.rounded_rectangle([30, 30, win_w + 30, win_h + 30], radius=16, fill=(0, 0, 0, 24))
shadow = shadow.filter(ImageFilter.GaussianBlur(14))
bg.paste(shadow, (win_x - 30 + 4, win_y - 30 + 8), shadow)

w_card = Image.new('RGBA', (win_w, win_h), BG + (255,))
wdraw = ImageDraw.Draw(w_card)
wdraw.rounded_rectangle([0, 0, win_w, win_h], radius=14, fill=BG + (255,))
wdraw.rectangle([0, TITLEBAR, win_w, win_h], fill=BG + (255,))
wdraw.ellipse([20, 14, 32, 26], fill=(255, 95, 86, 255))
wdraw.ellipse([40, 14, 52, 26], fill=(255, 189, 46, 255))
wdraw.ellipse([60, 14, 72, 26], fill=(39, 201, 63, 255))
wdraw.text((win_w // 2 - 95, 11), "DeepSeek Harness Workspace",
           fill=(148, 163, 184, 255), font=font_tag)
wdraw.line([(0, TITLEBAR), (win_w, TITLEBAR)], fill=(226, 232, 240, 255), width=1)
w_card.paste(sb_crop, (0, TITLEBAR + 1))
wdraw.rounded_rectangle([0, 0, win_w - 1, win_h - 1], radius=14,
                        outline=(203, 213, 225, 255), width=1)
bg.paste(w_card, (win_x, win_y), w_card)

# 文本行在原图中的 y 中心 → 画布 y = win_y + TITLEBAR + mid
def canvas_y(mid):
    return win_y + TITLEBAR + mid

# ---- 4. 右侧：无卡片，彩色数字圆点 + 大标题 + 一行精简解释 ----
callouts = [
    {
        "n": "1",
        "title": "侧边栏「添加远程主机」",
        "desc": "自动读取 ~/.ssh/config，点选即连，自动持久化",
        "y": 200,
        "anchor_y": canvas_y(221),   # “添加远程主机”行
        "anchor_x": win_x + win_w - 70,  # 行尾空白处，避免标注线压住文字
        "color": (37, 99, 235),
    },
    {
        "n": "2",
        "title": "远程主机根节点（一级目录）",
        "desc": "主机即一级目录，多台并存，行尾加号挂载远端路径",
        "y": 470,
        "anchor_y": canvas_y(415),   # dev 主机行行尾（加号按钮左侧空白）
        "anchor_x": win_x + 470,
        "color": (13, 148, 136),
    },
    {
        "n": "3",
        "title": "官方 UI 树原生嵌套与交互",
        "desc": "流式输出、切模型、提问卡片，全复用官方原生体验",
        "y": 740,
        "anchor_y": canvas_y(497),   # dsh-q20-web 工作区行行尾空白
        "anchor_x": win_x + 470,
        "color": (124, 58, 237),
    },
]

draw = ImageDraw.Draw(bg)
for c in callouts:
    cx, cy = 780, c["y"]

    # 彩色数字圆点
    r = 21
    ccx, ccy = cx + r, cy + r
    draw.ellipse([ccx - r, ccy - r, ccx + r, ccy + r], fill=(*c["color"], 255))
    nbox = draw.textbbox((0, 0), c["n"], font=font_num)
    draw.text((ccx - (nbox[2] - nbox[0]) / 2, ccy - (nbox[3] - nbox[1]) / 2 - nbox[1]),
              c["n"], fill=(255, 255, 255, 255), font=font_num)

    # 大标题（与页眉主标题同级字号）
    draw.text((ccx + r + 16, cy - 4), c["title"],
              fill=(15, 23, 42, 255), font=font_big)
    # 精简解释（一行灰色小字）
    draw.text((cx, cy + 62), c["desc"], fill=(100, 116, 139, 255), font=font_desc)

    # 连接线：描点 → 窗口右缘 → 数字圆点左缘
    tx, ty = c["anchor_x"], c["anchor_y"]
    draw.ellipse([tx - 5, ty - 5, tx + 5, ty + 5], fill=(*c["color"], 255))
    draw.ellipse([tx - 11, ty - 11, tx + 11, ty + 11],
                 outline=(*c["color"], 140), width=2)
    corner_x = win_x + win_w + 32
    end_x = ccx - r
    draw.line([(tx, ty), (corner_x, ty)], fill=(*c["color"], 180), width=2)
    draw.line([(corner_x, ty), (corner_x, ccy)], fill=(*c["color"], 180), width=2)
    draw.line([(corner_x, ccy), (end_x, ccy)], fill=(*c["color"], 180), width=2)

out = os.path.join("assets", "dsh-remote-ssh-showcase.png")
bg.convert("RGB").save(out, quality=95)
print("saved:", out)
