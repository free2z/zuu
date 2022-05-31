FROM debian

RUN apt update
# zcashd dependencies
RUN apt install -y git wget build-essential libncurses5 autotools-dev \
    automake libtool bsdmainutils pkg-config curl

# Install rust
RUN curl https://sh.rustup.rs -sSf | bash -s -- -y
RUN echo 'source $HOME/.cargo/env' >> $HOME/.bashrc

# Install golang
RUN wget https://golang.org/dl/go1.18.linux-amd64.tar.gz
RUN tar -zxvf go1.18.linux-amd64.tar.gz -C /usr/local/

# Install node
# TODO: update - 18.2.0 ...
RUN curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.1/install.sh | bash
ENV NODE_VERSION=17.9.0
ENV NVM_DIR=/root/.nvm
RUN . "$NVM_DIR/nvm.sh" && nvm install ${NODE_VERSION}
RUN . "$NVM_DIR/nvm.sh" && nvm use v${NODE_VERSION}
RUN . "$NVM_DIR/nvm.sh" && nvm alias default v${NODE_VERSION}
ENV PATH="${NVM_DIR}/versions/node/v${NODE_VERSION}/bin/:${PATH}"
RUN node --version
RUN npm --version

# TODO: maybe docker-in-docker?
# Install docker
# RUN curl -fsSL https://get.docker.com | sh
# systemd is a problem too
# systemctl enable docker.service
# systemctl enable containerd.service
# systemctl start docker.service
# System has not been booted with systemd as init system (PID 1). Can't operate.
# Failed to connect to bus: Host is down

# TODO: figure out how to use internal script :/
# RUN /workspaces/zcash/zcutil/fetch-params.sh
# RUN ./zcutil/build.sh -j4

# ------------ ZSH and extra/optional tools

# https://github.com/deluan/zsh-in-docker
RUN sh -c "$(wget -O- https://github.com/deluan/zsh-in-docker/releases/download/v1.1.2/zsh-in-docker.sh)" -- \
    -t robbyrussell
# Rust in zsh
RUN echo 'source $HOME/.cargo/env' >> $HOME/.zshrc
# Golang in zsh
RUN echo "export PATH=/usr/local/go/bin:${PATH}" >> $HOME/.zshrc

# CMD [ "zsh" ]
ENV SHELL /bin/zsh

# Random tools that should be optional
RUN apt install -y tree vim
