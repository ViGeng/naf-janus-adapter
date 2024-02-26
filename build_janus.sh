sudo apt-get -y update && sudo apt-get install -y libmicrohttpd-dev \
    libjansson-dev \
    libssl-dev \
    libglib2.0-dev \
    libopus-dev \
    libogg-dev \
    libconfig-dev \
    libssl-dev \
    pkg-config \
    gengetopt \
    libtool \
    automake \
    build-essential \
    subversion \
    git \
    cmake \
    unzip \
    zip \
    cargo \
    wget

cd /tmp
LIBWEBSOCKET="4.3.2" && wget https://github.com/warmcat/libwebsockets/archive/v$LIBWEBSOCKET.tar.gz && \
tar xzvf v$LIBWEBSOCKET.tar.gz && \
cd libwebsockets-$LIBWEBSOCKET && \
mkdir build && \
cd build && \
cmake -DLWS_MAX_SMP=1 -DLWS_WITHOUT_EXTENSIONS=0 -DCMAKE_INSTALL_PREFIX:PATH=/usr -DCMAKE_C_FLAGS="-fpic" .. && \
make && sudo make install

cd /tmp
SRTP="2.4.2" && wget https://github.com/cisco/libsrtp/archive/v$SRTP.tar.gz && \
tar xfv v$SRTP.tar.gz && \
cd libsrtp-$SRTP && \
./configure --prefix=/usr --enable-openssl && \
make shared_library && sudo make install

cd /tmp
# libnice 2021-02-21 11:10 (post 0.1.18)
sudo apt-get -y --no-install-recommends install ninja-build meson && \
sudo apt-get remove -y libnice-dev libnice10 && \
sudo apt-get install -y gtk-doc-tools libgnutls28-dev && \
git clone https://gitlab.freedesktop.org/libnice/libnice && \
cd libnice && \
git checkout 36aa468c4916cfccd4363f0e27af19f2aeae8604 && \
meson --prefix=/usr build && \
ninja -C build && \
sudo ninja -C build install

cd /tmp
# datachannel build
# Jan 13, 2021 0.9.5.0 07f871bda23943c43c9e74cc54f25130459de830
git clone https://github.com/sctplab/usrsctp.git && \
cd usrsctp && \
git checkout 0.9.5.0 && \
./bootstrap && \
./configure --prefix=/usr --disable-programs --disable-inet --disable-inet6 && \
make && sudo make install

cd /tmp
# 2022-10-21 15:02 7b6bcdcdbe02dd05932d778592f4c03604a83684 (post v0.13.0 from 0.x branch)
git clone -b 0.x https://github.com/meetecho/janus-gateway.git && \
cd janus-gateway && \
git checkout 7b6bcdcdbe02dd05932d778592f4c03604a83684 && \
sh autogen.sh && \
CFLAGS="${CFLAGS} -fno-omit-frame-pointer" ./configure --prefix=/usr \
--disable-all-plugins --disable-all-handlers && \
make && sudo make install && sudo make configs

cd /tmp
git clone -b master https://github.com/networked-aframe/janus-plugin-sfu.git && \
cd janus-plugin-sfu && \
git checkout 1914dfa7e22c793f4a684ebeb002304661270519 && \
cargo build --release && \
sudo mkdir -p /usr/lib/janus/plugins && \
sudo mkdir -p /usr/lib/janus/events && \
sudo cp /tmp/janus-plugin-sfu/target/release/libjanus_plugin_sfu.so /usr/lib/janus/plugins && \
sudo cp /tmp/janus-plugin-sfu/janus.plugin.sfu.cfg.example /usr/etc/janus/janus.plugin.sfu.cfg