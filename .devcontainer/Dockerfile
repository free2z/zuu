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
