import type { ResourceInfo } from '../../../shared/types';

/**
 * A resource view is one read-only CLI call plus a JMESPath query that shapes the
 * answer into flat rows. To add a service, add an entry here; nothing else changes.
 */
export interface ResourceDef extends ResourceInfo {
  /** CLI arguments, without --query and --output. */
  args: string[];
  /** JMESPath query returning a list of objects whose keys match the columns. */
  query: string;
}

export const RESOURCES: ResourceDef[] = [
  {
    id: 'ec2',
    title: 'EC2 instances',
    global: false,
    args: ['ec2', 'describe-instances'],
    query:
      "Reservations[].Instances[].{id:InstanceId,name:Tags[?Key=='Name']|[0].Value,state:State.Name,type:InstanceType,az:Placement.AvailabilityZone,privateIp:PrivateIpAddress,publicIp:PublicIpAddress,launched:LaunchTime}",
    columns: [
      { key: 'name', label: 'Name' },
      { key: 'id', label: 'Instance ID' },
      { key: 'state', label: 'State' },
      { key: 'type', label: 'Type' },
      { key: 'az', label: 'Zone' },
      { key: 'privateIp', label: 'Private IP' },
      { key: 'publicIp', label: 'Public IP' },
      { key: 'launched', label: 'Launched' },
    ],
  },
  {
    id: 's3',
    title: 'S3 buckets',
    global: true,
    args: ['s3api', 'list-buckets'],
    query: 'Buckets[].{name:Name,created:CreationDate}',
    columns: [
      { key: 'name', label: 'Bucket' },
      { key: 'created', label: 'Created' },
    ],
  },
  {
    id: 'lambda',
    title: 'Lambda functions',
    global: false,
    args: ['lambda', 'list-functions'],
    query: 'Functions[].{name:FunctionName,runtime:Runtime,memory:MemorySize,timeout:Timeout,modified:LastModified}',
    columns: [
      { key: 'name', label: 'Function' },
      { key: 'runtime', label: 'Runtime' },
      { key: 'memory', label: 'Memory (MB)' },
      { key: 'timeout', label: 'Timeout (s)' },
      { key: 'modified', label: 'Last modified' },
    ],
  },
  {
    id: 'rds',
    title: 'RDS instances',
    global: false,
    args: ['rds', 'describe-db-instances'],
    query:
      'DBInstances[].{id:DBInstanceIdentifier,engine:Engine,version:EngineVersion,class:DBInstanceClass,status:DBInstanceStatus,az:AvailabilityZone,endpoint:Endpoint.Address}',
    columns: [
      { key: 'id', label: 'Instance' },
      { key: 'engine', label: 'Engine' },
      { key: 'version', label: 'Version' },
      { key: 'class', label: 'Class' },
      { key: 'status', label: 'Status' },
      { key: 'az', label: 'Zone' },
      { key: 'endpoint', label: 'Endpoint' },
    ],
  },
  {
    id: 'cloudformation',
    title: 'CloudFormation stacks',
    global: false,
    args: ['cloudformation', 'describe-stacks'],
    query: 'Stacks[].{name:StackName,status:StackStatus,created:CreationTime,updated:LastUpdatedTime,description:Description}',
    columns: [
      { key: 'name', label: 'Stack' },
      { key: 'status', label: 'Status' },
      { key: 'created', label: 'Created' },
      { key: 'updated', label: 'Updated' },
      { key: 'description', label: 'Description' },
    ],
  },
  {
    id: 'alarms',
    title: 'CloudWatch alarms',
    global: false,
    args: ['cloudwatch', 'describe-alarms'],
    query: 'MetricAlarms[].{name:AlarmName,state:StateValue,metric:MetricName,namespace:Namespace,updated:StateUpdatedTimestamp}',
    columns: [
      { key: 'name', label: 'Alarm' },
      { key: 'state', label: 'State' },
      { key: 'metric', label: 'Metric' },
      { key: 'namespace', label: 'Namespace' },
      { key: 'updated', label: 'State changed' },
    ],
  },
];
