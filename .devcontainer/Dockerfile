FROM debian

RUN apt update
# zcashd dependencies
RUN apt install -y git wget build-essential libncurses5 autotools-dev \
    automake libtool bsdmainutils pkg-config

# TODO: figure out how to use internal script :/
# RUN /workspaces/zcash/zcutil/fetch-params.sh
# RUN ./zcutil/build.sh -j4

# https://github.com/deluan/zsh-in-docker
RUN sh -c "$(wget -O- https://github.com/deluan/zsh-in-docker/releases/download/v1.1.2/zsh-in-docker.sh)" -- \
    -t robbyrussell

# Personal preference really
RUN apt install -y tree

# CMD [ "zsh" ]
ENV SHELL /bin/zsh
