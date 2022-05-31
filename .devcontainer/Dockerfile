FROM debian

RUN apt update
# zcashd dependencies
RUN apt install -y git wget build-essential libncurses5 autotools-dev \
    automake libtool bsdmainutils pkg-config curl

# Install rust
RUN curl https://sh.rustup.rs -sSf | bash -s -- -y

# Install golang
RUN wget https://golang.org/dl/go1.18.linux-amd64.tar.gz
RUN tar -zxvf go1.18.linux-amd64.tar.gz -C /usr/local/

# Electron deps
RUN apt install -y libxshmfence1 libnss3 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libdrm2 libgtk-3-0 libgbm1 libasound2

# Install node
RUN curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.1/install.sh | bash
ENV NODE_VERSION=18.2.0
ENV NVM_DIR=/root/.nvm
RUN . "$NVM_DIR/nvm.sh" && nvm install ${NODE_VERSION}
RUN . "$NVM_DIR/nvm.sh" && nvm use v${NODE_VERSION}
RUN . "$NVM_DIR/nvm.sh" && nvm alias default v${NODE_VERSION}
ENV PATH="${NVM_DIR}/versions/node/v${NODE_VERSION}/bin/:${PATH}"
RUN node --version
RUN npm --version
RUN npm install -g yarn

# Install docker
RUN apt install -y \
    ca-certificates \
    curl \
    gnupg \
    lsb-release
RUN mkdir -p /etc/apt/keyrings
RUN curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
RUN echo \
    "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian \
    $(lsb_release -cs) stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null
RUN apt update
RUN apt install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

# zecwallet-lite
# zingolabs/zecwalletlitelib
RUN apt install -y cmake

# TODO: use COPY to add script ... from submodule?
# RUN /workspaces/zcash/zcutil/fetch-params.sh
# RUN ./zcutil/build.sh -j4

# ------------ ZSH and extra/optional tools

# https://github.com/deluan/zsh-in-docker
RUN sh -c "$(wget -O- https://github.com/deluan/zsh-in-docker/releases/download/v1.1.2/zsh-in-docker.sh)" -- \
    -t robbyrussell
ENV SHELL /bin/zsh

# Add paths for Rust and Golang
RUN echo "export PATH=/root/.cargo/bin:/usr/local/go/bin:${PATH}" >> $HOME/.zshrc

# Random tools that should be optional
RUN apt install -y tree vim

# Too into people's options?
RUN git config --global pull.rebase false
