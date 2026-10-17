import os
import io
import resvg_py
from PIL import Image

def generate_all_icons(public_dir: str):
    os.makedirs(public_dir, exist_ok=True)

    # 1. Base clean SVG for the logo badge (transparent background, radius 46 + 4px stroke)
    svg_badge = '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <circle cx="50" cy="50" r="46" fill="#181825" stroke="#cba6f7" stroke-width="4.5"/>
  <path d="M30 65 Q50 58 70 65" stroke="#fab387" stroke-width="6" stroke-linecap="round" fill="none"/>
  <path d="M25 50 Q50 40 75 50" stroke="#cba6f7" stroke-width="7" stroke-linecap="round" fill="none"/>
  <path d="M22 35 Q50 22 78 35" stroke="#94e2d5" stroke-width="8" stroke-linecap="round" fill="none"/>
</svg>'''

    # 2. Maskable SVG for Android adaptive icons (solid #181825 background, badge scaled inside 80% safe zone)
    svg_maskable = '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" fill="#181825"/>
  <g transform="translate(50, 50) scale(0.78) translate(-50, -50)">
    <circle cx="50" cy="50" r="46" fill="#181825" stroke="#cba6f7" stroke-width="4.5"/>
    <path d="M30 65 Q50 58 70 65" stroke="#fab387" stroke-width="6" stroke-linecap="round" fill="none"/>
    <path d="M25 50 Q50 40 75 50" stroke="#cba6f7" stroke-width="7" stroke-linecap="round" fill="none"/>
    <path d="M22 35 Q50 22 78 35" stroke="#94e2d5" stroke-width="8" stroke-linecap="round" fill="none"/>
  </g>
</svg>'''

    # 3. Apple Touch Icon SVG (iOS home screen icon, solid #181825 background, badge scaled inside rounded squircle area)
    svg_apple = '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" fill="#181825"/>
  <g transform="translate(50, 50) scale(0.82) translate(-50, -50)">
    <circle cx="50" cy="50" r="46" fill="#181825" stroke="#cba6f7" stroke-width="4.5"/>
    <path d="M30 65 Q50 58 70 65" stroke="#fab387" stroke-width="6" stroke-linecap="round" fill="none"/>
    <path d="M25 50 Q50 40 75 50" stroke="#cba6f7" stroke-width="7" stroke-linecap="round" fill="none"/>
    <path d="M22 35 Q50 22 78 35" stroke="#94e2d5" stroke-width="8" stroke-linecap="round" fill="none"/>
  </g>
</svg>'''

    # Save favicon.svg
    svg_path = os.path.join(public_dir, 'favicon.svg')
    with open(svg_path, 'w', encoding='utf-8') as f:
        f.write(svg_badge)
    print(f"Updated {svg_path}")

    # Generate pwa-192x192.png (purpose: any)
    pwa192_bytes = resvg_py.svg_to_bytes(svg_string=svg_badge, width=192, height=192)
    pwa192_path = os.path.join(public_dir, 'pwa-192x192.png')
    with open(pwa192_path, 'wb') as f:
        f.write(pwa192_bytes)
    print(f"Generated {pwa192_path} (192x192)")

    # Generate pwa-512x512.png (purpose: any)
    pwa512_bytes = resvg_py.svg_to_bytes(svg_string=svg_badge, width=512, height=512)
    pwa512_path = os.path.join(public_dir, 'pwa-512x512.png')
    with open(pwa512_path, 'wb') as f:
        f.write(pwa512_bytes)
    print(f"Generated {pwa512_path} (512x512)")

    # Generate pwa-maskable-512x512.png (purpose: maskable)
    mask512_bytes = resvg_py.svg_to_bytes(svg_string=svg_maskable, width=512, height=512)
    mask512_path = os.path.join(public_dir, 'pwa-maskable-512x512.png')
    with open(mask512_path, 'wb') as f:
        f.write(mask512_bytes)
    print(f"Generated {mask512_path} (512x512 maskable)")

    # Generate apple-touch-icon.png (180x180)
    apple_bytes = resvg_py.svg_to_bytes(svg_string=svg_apple, width=180, height=180)
    apple_path = os.path.join(public_dir, 'apple-touch-icon.png')
    with open(apple_path, 'wb') as f:
        f.write(apple_bytes)
    print(f"Generated {apple_path} (180x180)")

    # Generate favicon.png (64x64)
    fav64_bytes = resvg_py.svg_to_bytes(svg_string=svg_badge, width=64, height=64)
    fav64_path = os.path.join(public_dir, 'favicon.png')
    with open(fav64_path, 'wb') as f:
        f.write(fav64_bytes)
    print(f"Generated {fav64_path} (64x64)")

    # Generate multi-size favicon.ico (16, 32, 48, 64)
    fav_im64 = Image.open(io.BytesIO(fav64_bytes))
    fav_im32 = Image.open(io.BytesIO(resvg_py.svg_to_bytes(svg_string=svg_badge, width=32, height=32)))
    fav_im16 = Image.open(io.BytesIO(resvg_py.svg_to_bytes(svg_string=svg_badge, width=16, height=16)))
    fav_im48 = Image.open(io.BytesIO(resvg_py.svg_to_bytes(svg_string=svg_badge, width=48, height=48)))

    ico_path = os.path.join(public_dir, 'favicon.ico')
    fav_im64.save(
        ico_path,
        format='ICO',
        sizes=[(16, 16), (32, 32), (48, 48), (64, 64)],
        append_images=[fav_im16, fav_im32, fav_im48]
    )
    print(f"Generated {ico_path} (multi-size ICO)")

if __name__ == '__main__':
    target = os.path.join(os.path.dirname(__file__), 'frontend', 'public')
    generate_all_icons(target)
