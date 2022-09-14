## Resize disk on debian

Assuming the blockchain lives on `/dev/sda1`.
Change the size of the disk for the VM with the cloud provider.
Then resize the partitions to fill the extra disk:

```
sudo apt install cloud-utils fdisk
sudo growpart /dev/sda 1
sudo resize2fs /dev/sda1
```
