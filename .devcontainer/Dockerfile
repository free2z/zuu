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
RUN curl https://sh.rustup.rs -sSf | bash -s -- -y

# Install golang
RUN sudo wget https://golang.org/dl/go1.18.linux-amd64.tar.gz
RUN sudo tar -zxvf go1.18.linux-amd64.tar.gz -C /usr/local/

# # Electron deps
# # still working on it ... hrm ...
# # https://gist.github.com/weedz/c962d69078391115635772b279264c02#file-dockerfile
# # https://stackoverflow.com/questions/67363396/configure-devcontainer-to-run-electron-app
RUN sudo apt install -y libxshmfence1 libnss3 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libdrm2 libgtk-3-0 libgbm1 libasound2 \
    xorg openbox libatk-adaptor
#
# https://github.com/virgilioneto/xvfb-electron/blob/master/node8-electron1.8.1-stretch/Dockerfile
# https://github.com/puppeteer/puppeteer/issues/8148
# https://github.com/microsoft/vscode-remote-release/issues/550
# React-native all the things?
# https://microsoft.github.io/react-native-windows/

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
