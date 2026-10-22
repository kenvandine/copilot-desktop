# Maintainer: kenvandine <kenvandine@gmail.com>

pkgname=/copilot-desktop
pkgver=0.1.0
pkgrel=1
pkgdesc="Unofficial Web app for Microsoft Copilot providing the desktop user experience you would expect on Ubuntu or any other Linux desktop"
arch=(x86_64)
url="https://github.com/kenvandine/copilot-desktop"
license=(GPL3)
provides=(copilot-desktop)
conflicts=(copilot-desktop)
depends=(electron nodejs npm libxtst libxss libasound2 libgtk3 libnss libgbm)
optdepends=("pulseaudio: audio recording support")
source=("https://github.com/kenvandine/copilot-desktop/archive/v$pkgver.tar.gz")
sha256sums=("SKIP")

prepare() {
  cd "$srcdir/copilot-desktop-$pkgver"
  
  # Set version in package.json
  sed -i "s/@@VERSION@@/$pkgver/g" package.json
}

build() {
  cd "$srcdir/copilot-desktop-$pkgver"
  
  # Install dependencies
  npm install
  
  # Build the application
  npm run build
}

package() {
  cd "$srcdir/copilot-desktop-$pkgver"
  
  # Create directories
  install -dm755 "$pkgdir/usr/lib/copilot-desktop"
  install -dm755 "$pkgdir/usr/share/applications"
  install -dm755 "$pkgdir/usr/share/icons/hicolor/512x512/apps"
  
  # Copy application files
  cp -r dist/linux*-unpacked/* "$pkgdir/usr/lib/copilot-desktop"
  
  # Copy desktop files
  install -m644 com.github.kenvandine.copilot-desktop.desktop "$pkgdir/usr/share/applications/"
  install -m644 com.github.kenvandine.copilot-desktop-autostart.desktop "$pkgdir/usr/share/applications/"
  install -m644 com.github.kenvandine.copilot-desktop-daemon.desktop "$pkgdir/usr/share/applications/"
  
  # Copy icon
  install -m644 assets/img/icon512.png "$pkgdir/usr/share/icons/hicolor/512x512/apps/copilot-desktop.png"
  
  # Create symlink for launcher
  install -dm755 "$pkgdir/usr/bin"
  ln -s /usr/lib/copilot-desktop/copilot-desktop "$pkgdir/usr/bin/copilot-desktop"
}

# vim: ts=2 sw=2 et
