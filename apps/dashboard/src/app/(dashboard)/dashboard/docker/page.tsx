'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Container,
  Image,
  Network,
  HardDrive,
  Play,
  Square,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { api } from '@/lib/api';
import { useTranslation } from '@/lib/i18n';
import { cn } from '@/lib/utils';

type Tab = 'containers' | 'images' | 'networks' | 'volumes';

interface DockerContainer {
  id: string;
  name: string;
  image: string;
  status: string;
  ports: string;
}

interface DockerImage {
  id: string;
  tags: string[];
  size: number;
  created: string;
}

interface DockerNetwork {
  id: string;
  name: string;
  driver: string;
  scope: string;
}

interface DockerVolume {
  name: string;
  driver: string;
  mountpoint: string;
}

const tabDefs: { key: Tab; labelKey: string; icon: React.ElementType }[] = [
  { key: 'containers', labelKey: 'docker.containers', icon: Container },
  { key: 'images', labelKey: 'docker.images', icon: Image },
  { key: 'networks', labelKey: 'docker.networks', icon: Network },
  { key: 'volumes', labelKey: 'docker.volumes', icon: HardDrive },
];

const containerStatusVariant: Record<string, 'success' | 'secondary' | 'warning' | 'destructive'> = {
  running: 'success',
  stopped: 'secondary',
  paused: 'warning',
  exited: 'destructive',
  restarting: 'warning',
  dead: 'destructive',
};

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

export default function DockerPage() {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<Tab>('containers');
  const queryClient = useQueryClient();

  const { data: server } = useQuery<any>({
    queryKey: ['server-local'],
    queryFn: () => api.get('/servers/local'),
  });
  const serverId = server?.id || '';

  const { data: containers = [], isLoading: containersLoading } = useQuery<DockerContainer[]>({
    queryKey: ['docker', 'containers', serverId],
    queryFn: () => api.get(`/docker/servers/${serverId}/containers`),
    enabled: !!serverId && activeTab === 'containers',
  });

  const { data: images = [], isLoading: imagesLoading } = useQuery<DockerImage[]>({
    queryKey: ['docker', 'images', serverId],
    queryFn: () => api.get(`/docker/servers/${serverId}/images`),
    enabled: !!serverId && activeTab === 'images',
  });

  const { data: networks = [], isLoading: networksLoading } = useQuery<DockerNetwork[]>({
    queryKey: ['docker', 'networks', serverId],
    queryFn: () => api.get(`/docker/servers/${serverId}/networks`),
    enabled: !!serverId && activeTab === 'networks',
  });

  const { data: volumes = [], isLoading: volumesLoading } = useQuery<DockerVolume[]>({
    queryKey: ['docker', 'volumes', serverId],
    queryFn: () => api.get(`/docker/servers/${serverId}/volumes`),
    enabled: !!serverId && activeTab === 'volumes',
  });

  const containerAction = useMutation({
    mutationFn: ({ containerId, action }: { containerId: string; action: string }) =>
      api.post(`/docker/servers/${serverId}/containers/action`, { containerId, action }),
    onSuccess: (_, { action }) => {
      toast.success(`Container ${action} successful`);
      queryClient.invalidateQueries({ queryKey: ['docker', 'containers', serverId] });
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">{t('docker.title')}</h1>
        <p className="text-muted-foreground">
          {t('docker.subtitle')}
        </p>
      </div>

      <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
        Docker shows <strong>all containers</strong> running on your server, including system containers.
        To manage Kryptalis-deployed applications, use the <a href="/dashboard/applications" className="text-primary hover:underline">Applications</a> page.
      </div>

      {!serverId ? (
        <Card>
          <CardContent className="flex items-center justify-center py-16">
            <p className="text-sm text-muted-foreground">Loading server...</p>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Tabs */}
          <div className="flex gap-1 rounded-lg border border-border bg-muted/50 p-1">
            {tabDefs.map((tab) => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={cn(
                  'flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors',
                  activeTab === tab.key
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                <tab.icon size={16} />
                {t(tab.labelKey)}
              </button>
            ))}
          </div>

          {/* Containers Tab */}
          {activeTab === 'containers' && (
            <Card>
              {containersLoading ? (
                <CardContent className="flex items-center justify-center py-16">
                  <p className="text-sm text-muted-foreground">Loading containers...</p>
                </CardContent>
              ) : containers.length === 0 ? (
                <CardContent className="flex flex-col items-center justify-center py-16">
                  <Container size={48} className="mb-4 text-muted-foreground" />
                  <p className="text-lg font-medium">{t('docker.noContainers')}</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Deploy an application to create containers
                  </p>
                </CardContent>
              ) : (
                <CardContent className="p-0">
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead>
                        <tr className="border-b border-border text-left text-sm text-muted-foreground">
                          <th className="px-6 py-3 font-medium">Name</th>
                          <th className="px-6 py-3 font-medium">Image</th>
                          <th className="px-6 py-3 font-medium">Status</th>
                          <th className="px-6 py-3 font-medium">Ports</th>
                          <th className="px-6 py-3 font-medium">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {containers.map((container) => (
                          <tr
                            key={container.id}
                            className="border-b border-border last:border-0 hover:bg-muted/50"
                          >
                            <td className="px-6 py-4 font-medium">{container.name}</td>
                            <td className="px-6 py-4 text-sm text-muted-foreground">
                              {container.image}
                            </td>
                            <td className="px-6 py-4">
                              <Badge
                                variant={
                                  containerStatusVariant[container.status] || 'secondary'
                                }
                              >
                                {container.status}
                              </Badge>
                            </td>
                            <td className="px-6 py-4 text-sm text-muted-foreground">
                              {container.ports || '--'}
                            </td>
                            <td className="px-6 py-4">
                              <div className="flex items-center gap-1">
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="h-8 w-8"
                                  title="Start"
                                  disabled={containerAction.isPending}
                                  onClick={() =>
                                    containerAction.mutate({
                                      containerId: container.id,
                                      action: 'start',
                                    })
                                  }
                                >
                                  <Play size={14} />
                                </Button>
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="h-8 w-8"
                                  title="Stop"
                                  disabled={containerAction.isPending}
                                  onClick={() =>
                                    containerAction.mutate({
                                      containerId: container.id,
                                      action: 'stop',
                                    })
                                  }
                                >
                                  <Square size={14} />
                                </Button>
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="h-8 w-8"
                                  title="Restart"
                                  disabled={containerAction.isPending}
                                  onClick={() =>
                                    containerAction.mutate({
                                      containerId: container.id,
                                      action: 'restart',
                                    })
                                  }
                                >
                                  <RotateCcw size={14} />
                                </Button>
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="h-8 w-8 text-destructive"
                                  title="Remove"
                                  disabled={containerAction.isPending}
                                  onClick={() =>
                                    containerAction.mutate({
                                      containerId: container.id,
                                      action: 'remove',
                                    })
                                  }
                                >
                                  <Trash2 size={14} />
                                </Button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              )}
            </Card>
          )}

          {/* Images Tab */}
          {activeTab === 'images' && (
            <Card>
              {imagesLoading ? (
                <CardContent className="flex items-center justify-center py-16">
                  <p className="text-sm text-muted-foreground">Loading images...</p>
                </CardContent>
              ) : images.length === 0 ? (
                <CardContent className="flex flex-col items-center justify-center py-16">
                  <Image size={48} className="mb-4 text-muted-foreground" />
                  <p className="text-lg font-medium">{t('docker.noImages')}</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Pull or build Docker images to get started
                  </p>
                </CardContent>
              ) : (
                <CardContent className="p-0">
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead>
                        <tr className="border-b border-border text-left text-sm text-muted-foreground">
                          <th className="px-6 py-3 font-medium">ID</th>
                          <th className="px-6 py-3 font-medium">Tags</th>
                          <th className="px-6 py-3 font-medium">Size</th>
                          <th className="px-6 py-3 font-medium">Created</th>
                        </tr>
                      </thead>
                      <tbody>
                        {images.map((image) => (
                          <tr
                            key={image.id}
                            className="border-b border-border last:border-0 hover:bg-muted/50"
                          >
                            <td className="px-6 py-4 font-mono text-sm">
                              {image.id.slice(0, 12)}
                            </td>
                            <td className="px-6 py-4">
                              <div className="flex flex-wrap gap-1">
                                {image.tags && image.tags.length > 0 ? (
                                  image.tags.map((tag) => (
                                    <Badge key={tag} variant="outline">
                                      {tag}
                                    </Badge>
                                  ))
                                ) : (
                                  <span className="text-sm text-muted-foreground">&lt;none&gt;</span>
                                )}
                              </div>
                            </td>
                            <td className="px-6 py-4 text-sm text-muted-foreground">
                              {formatBytes(image.size)}
                            </td>
                            <td className="px-6 py-4 text-sm text-muted-foreground">
                              {image.created}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              )}
            </Card>
          )}

          {/* Networks Tab */}
          {activeTab === 'networks' && (
            <Card>
              {networksLoading ? (
                <CardContent className="flex items-center justify-center py-16">
                  <p className="text-sm text-muted-foreground">Loading networks...</p>
                </CardContent>
              ) : networks.length === 0 ? (
                <CardContent className="flex flex-col items-center justify-center py-16">
                  <Network size={48} className="mb-4 text-muted-foreground" />
                  <p className="text-lg font-medium">{t('docker.noNetworks')}</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Docker networks will appear here
                  </p>
                </CardContent>
              ) : (
                <CardContent className="p-0">
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead>
                        <tr className="border-b border-border text-left text-sm text-muted-foreground">
                          <th className="px-6 py-3 font-medium">Name</th>
                          <th className="px-6 py-3 font-medium">Driver</th>
                          <th className="px-6 py-3 font-medium">Scope</th>
                        </tr>
                      </thead>
                      <tbody>
                        {networks.map((network) => (
                          <tr
                            key={network.id}
                            className="border-b border-border last:border-0 hover:bg-muted/50"
                          >
                            <td className="px-6 py-4 font-medium">{network.name}</td>
                            <td className="px-6 py-4 text-sm text-muted-foreground">
                              {network.driver}
                            </td>
                            <td className="px-6 py-4 text-sm text-muted-foreground">
                              {network.scope}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              )}
            </Card>
          )}

          {/* Volumes Tab */}
          {activeTab === 'volumes' && (
            <Card>
              {volumesLoading ? (
                <CardContent className="flex items-center justify-center py-16">
                  <p className="text-sm text-muted-foreground">Loading volumes...</p>
                </CardContent>
              ) : volumes.length === 0 ? (
                <CardContent className="flex flex-col items-center justify-center py-16">
                  <HardDrive size={48} className="mb-4 text-muted-foreground" />
                  <p className="text-lg font-medium">{t('docker.noVolumes')}</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Docker volumes will appear here
                  </p>
                </CardContent>
              ) : (
                <CardContent className="p-0">
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead>
                        <tr className="border-b border-border text-left text-sm text-muted-foreground">
                          <th className="px-6 py-3 font-medium">Name</th>
                          <th className="px-6 py-3 font-medium">Driver</th>
                          <th className="px-6 py-3 font-medium">Mountpoint</th>
                        </tr>
                      </thead>
                      <tbody>
                        {volumes.map((volume) => (
                          <tr
                            key={volume.name}
                            className="border-b border-border last:border-0 hover:bg-muted/50"
                          >
                            <td className="px-6 py-4 font-medium">{volume.name}</td>
                            <td className="px-6 py-4 text-sm text-muted-foreground">
                              {volume.driver}
                            </td>
                            <td className="px-6 py-4 text-sm font-mono text-muted-foreground">
                              {volume.mountpoint}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              )}
            </Card>
          )}
        </>
      )}
    </div>
  );
}
