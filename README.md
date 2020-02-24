# aws-cni

Allocate maximum number of available interfaces to the EC2 instance.
Inspired by [amazon-vpc-cni-k8s](https://github.com/aws/amazon-vpc-cni-k8s)

When an EC2 instance is launched it has a maximum of 2 ENI attached. With the aws-cni service, you can allocate the maximum number of ENI allowed by the instance. Refer to the [VPCLimits](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/using-eni.html#AvailableIpPerENI). This can be configured to attach Elastic Ips to each interface.

For example, a a1.4xlarge instance can have 8 maximum network interfaces and each interface can have upto 30 ip addresses, for a total of 240 ips.

```javascript

const AWSService = require('@schaitanya/aws-cni');

await AWSService.checkIfInstanceHasValidInterfaces();

```
