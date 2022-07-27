FROM debian

RUN apt update

# Create sudo user "dev"
ARG USERNAME=dev
ARG USER_UID=1000
ARG USER_GID=$USER_UID

# Create the `dev` user
# https://code.visualstudio.com/remote/advancedcontainers/add-nonroot-user
RUN groupadd --gid $USER_GID $USERNAME \
    && useradd --uid $USER_UID --gid $USER_GID -m $USERNAME \
    && apt-get update \
    && apt-get install -y sudo \
    && echo $USERNAME ALL=\(root\) NOPASSWD:ALL > /etc/sudoers.d/$USERNAME \
    && chmod 0440 /etc/sudoers.d/$USERNAME
USER $USERNAME

# zcashd dependencies
RUN sudo apt install -y git wget build-essential libncurses5 autotools-dev \
    automake libtool bsdmainutils pkg-config curl

# Install rust
# RUN curl https://sh.rustup.rs -sSf | bash -s -- -y
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs -o /home/dev/rustup.sh
RUN chmod +x /home/dev/rustup.sh && /home/dev/rustup.sh -y

# Install golang
RUN sudo wget https://golang.org/dl/go1.18.linux-amd64.tar.gz
RUN sudo tar -zxvf go1.18.linux-amd64.tar.gz -C /usr/local/

# Install node
RUN curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.1/install.sh | bash
# ENV NODE_VERSION=18.2.0
# Use LTS
ENV NODE_VERSION=16.15.1
ENV NVM_DIR=/home/dev/.nvm
RUN . "$NVM_DIR/nvm.sh" && nvm install ${NODE_VERSION}
RUN . "$NVM_DIR/nvm.sh" && nvm use v${NODE_VERSION}
RUN . "$NVM_DIR/nvm.sh" && nvm alias default v${NODE_VERSION}
ENV PATH="${NVM_DIR}/versions/node/v${NODE_VERSION}/bin/:${PATH}"
RUN node --version
RUN npm --version
RUN npm install -g yarn

# React-native ...
# RUN npm install -g expo-cli


# Install docker
RUN sudo apt install -y \
    ca-certificates \
    curl \
    gnupg \
    lsb-release
RUN sudo mkdir -p /etc/apt/keyrings
RUN curl -fsSL https://download.docker.com/linux/debian/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
RUN echo \
    "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian \
    $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
RUN sudo apt update
RUN sudo apt install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
RUN sudo usermod -aG docker $USERNAME

# zecwallet-lite
# zingolabs/zecwalletlitelib
RUN sudo apt install -y cmake

# Install python3 for Free2z, etc
# TODO: pin?
RUN sudo apt install -y python3-pip python3-dev python3-virtualenv \
    libpq-dev libcurl4-openssl-dev libssl-dev

# TODO: use COPY to add script ... from submodule?
# RUN /workspaces/zcash/zcutil/fetch-params.sh
# RUN ./zcutil/build.sh -j4


# Ionic/Capacitor
# https://ionicframework.com/docs/react/your-first-app
RUN npm install -g @ionic/cli native-run cordova-res


# More electron zecwallet-lite stuff
# Failed to move to new namespace: PID namespaces supported,
# Network namespace supported, but failed: errno = Operation not permitted
# RUN echo 'kernel.unprivileged_userns_clone=1' | sudo tee -a /etc/sysctl.d/00-local-userns.conf
# RUN sudo service procps restart

# ------------ ZSH and extra/optional tools

# https://github.com/deluan/zsh-in-docker
RUN sh -c "$(wget -O- https://github.com/deluan/zsh-in-docker/releases/download/v1.1.2/zsh-in-docker.sh)" -- \
    -t robbyrussell
ENV SHELL /bin/zsh

# Add paths for Rust and Golang
RUN echo "export PATH=/home/dev/.cargo/bin:/usr/local/go/bin:${PATH}" >> $HOME/.zshrc

# General caching across rebuilds
# RUN mkdir /root/zcache

# -----------------------------------------

# Random tools that should be optional
RUN sudo apt install -y tree vim

# Too into people's options?
# Instead, mount $HOME/.gitconfig - see devcontainer.json
# RUN git config --global pull.rebase false



# -------- WIP




# # Electron deps
# # still working on it ... hrm ...
# # https://gist.github.com/weedz/c962d69078391115635772b279264c02#file-dockerfile
# # https://stackoverflow.com/questions/67363396/configure-devcontainer-to-run-electron-app

# https://gist.github.com/paul-krohn/e45f96181b1cf5e536325d1bdee6c949
# https://gist.github.com/cschiewek/246a244ba23da8b9f0e7b11a68bf3285
# https://github.com/microsoft/vscode-remote-release/issues/550
RUN sudo apt install -y \
    # libxshmfence1 libnss3 libatk1.0-0 libatk-bridge2.0-0 \
    # libcups2 libdrm2 libgtk-3-0 libgbm1 libasound2 \
    # xorg openbox libatk-adaptor
    # TODO: what if someone's host is different :/
    # https://jaked.org/blog/2021-02-18-How-to-run-Electron-on-Linux-on-Docker-on-Mac
    # https://gist.github.com/cschiewek/246a244ba23da8b9f0e7b11a68bf3285
    libx11-xcb1 libxcb-dri3-0 libxtst6 libnss3 libatk-bridge2.0-0 libgtk-3-0 libxss1 libasound2 \
    libdrm2 libgbm1
# TODO: webgl
# # Does provide .so ...
# libgl1-mesa-glx \
# # https://hub.docker.com/r/cypress/base/dockerfile
# libgtk2.0-0 libnotify-dev libgconf-2-4 libnss3 libxss1 libasound2 xvfb \
# chromium
# https://askubuntu.com/questions/834254/steam-libgl-error-no-matching-fbconfigs-or-visuals-found-libgl-error-failed-t
# https://github.com/cypress-io/cypress/issues/4925
# https://stackoverflow.com/questions/16296753/can-you-run-gui-applications-in-a-linux-docker-container
# https://stackoverflow.com/questions/55313610/importerror-libgl-so-1-cannot-open-shared-object-file-no-such-file-or-directo

#
# https://github.com/virgilioneto/xvfb-electron/blob/master/node8-electron1.8.1-stretch/Dockerfile
# https://github.com/puppeteer/puppeteer/issues/8148
# https://github.com/microsoft/vscode-remote-release/issues/550
# React-native all the things?
# https://microsoft.github.io/react-native-windows/
# https://stackoverflow.com/a/61043049/177293
# RUN sudo apt install -y xvfb gtk2-engines-pixbuf dbus-x11 xfonts-base \
#     xfonts-100dpi xfonts-75dpi xfonts-cyrillic xfonts-scalable
# RUN Xvfb -ac :99 -screen 0 1280x1024x16 & export DISPLAY=:99


# grpc-web
RUN sudo apt install -y protobuf-compiler
RUN sudo wget https://github.com/grpc/grpc-web/releases/download/1.3.1/protoc-gen-grpc-web-1.3.1-linux-x86_64
RUN sudo chmod +x protoc-gen-grpc-web-1.3.1-linux-x86_64
RUN sudo cp protoc-gen-grpc-web-1.3.1-linux-x86_64 /usr/local/bin/protoc-gen-grpc-web


# I think basically you want to run mobile dev with a GUI on the host :/
#
# zingo-mobile
# RUN sudo apt install -y rubygems ruby-dev
## Android
# RUN sudo apt install -y x11-apps openjdk-17-jdk
#
#RUN sudo apt install -y default-jdk
#RUN wget https://redirector.gvt1.com/edgedl/android/studio/ide-zips/2020.3.1.26/android-studio-2020.3.1.26-linux.tar.gz
#
# https://developer.android.com/studio/install#linux
# https://wiki.debian.org/AndroidStudio
# https://techviewleo.com/how-to-install-android-studio-on-debian/
# https://github.com/docker-android-sdk/android-30/blob/master/Dockerfile
#
