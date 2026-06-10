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
import type {
  ContainerResponse,
  DockerImageResponse,
  DockerNetworkResponse,
  DockerVolumeResponse,
} from '@kryptalis/types';

type Tab = 'containers' | 'images' | 'networks' | 'volumes';

type DockerContainer = ContainerResponse;
type DockerImage = DockerImageResponse;
type DockerNetwork = DockerNetworkResponse;
type DockerVolume = DockerVolumeResponse;

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

const ACTION_TOAST_KEY: Record<string, string> = {
  start: 'docker.toastStart',
  stop: 'docker.toastStop',
  restart: 'docker.toastRestart',
  remove: 'docker.toastRemove',
};

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
      const key = ACTION_TOAST_KEY[action] ?? 'docker.toastStart';
      toast.success(t(key));
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
        {t('docker.infoBannerPrefix')}<strong>{t('docker.infoBannerBold')}</strong>{t('docker.infoBannerMiddle')}<a href="/dashboard/applications" className="text-primary hover:underline">{t('docker.infoBannerLink')}</a>{t('docker.infoBannerSuffix')}
      </div>

      {!serverId ? (
        <Card>
          <CardContent className="flex items-center justify-center py-16">
            <p className="text-sm text-muted-foreground">{t('docker.loadingServer')}</p>
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
                  <p className="text-sm text-muted-foreground">{t('docker.loadingContainers')}</p>
                </CardContent>
              ) : containers.length === 0 ? (
                <CardContent className="flex flex-col items-center justify-center py-16">
                  <Container size={48} className="mb-4 text-muted-foreground" />
                  <p className="text-lg font-medium">{t('docker.noContainers')}</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {t('docker.noContainersDesc')}
                  </p>
                </CardContent>
              ) : (
                <CardContent className="p-0">
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead>
                        <tr className="border-b border-border text-left text-sm text-muted-foreground">
                          <th className="px-6 py-3 font-medium">{t('docker.colName')}</th>
                          <th className="px-6 py-3 font-medium">{t('docker.colImage')}</th>
                          <th className="px-6 py-3 font-medium">{t('docker.colStatus')}</th>
                          <th className="px-6 py-3 font-medium">{t('docker.colPorts')}</th>
                          <th className="px-6 py-3 font-medium">{t('docker.colActions')}</th>
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
                                  title={t('docker.actionStart')}
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
                                  title={t('docker.actionStop')}
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
                                  title={t('docker.actionRestart')}
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
                                  title={t('docker.actionRemove')}
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
                  <p className="text-sm text-muted-foreground">{t('docker.loadingImages')}</p>
                </CardContent>
              ) : images.length === 0 ? (
                <CardContent className="flex flex-col items-center justify-center py-16">
                  <Image size={48} className="mb-4 text-muted-foreground" />
                  <p className="text-lg font-medium">{t('docker.noImages')}</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {t('docker.noImagesDesc')}
                  </p>
                </CardContent>
              ) : (
                <CardContent className="p-0">
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead>
                        <tr className="border-b border-border text-left text-sm text-muted-foreground">
                          <th className="px-6 py-3 font-medium">{t('docker.colId')}</th>
                          <th className="px-6 py-3 font-medium">{t('docker.colTags')}</th>
                          <th className="px-6 py-3 font-medium">{t('docker.colSize')}</th>
                          <th className="px-6 py-3 font-medium">{t('docker.colCreated')}</th>
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
                                  <span className="text-sm text-muted-foreground">{t('docker.tagNone')}</span>
                                )}
                              </div>
                            </td>
                            <td className="px-6 py-4 text-sm text-muted-foreground">
                              {image.size}
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
                  <p className="text-sm text-muted-foreground">{t('docker.loadingNetworks')}</p>
                </CardContent>
              ) : networks.length === 0 ? (
                <CardContent className="flex flex-col items-center justify-center py-16">
                  <Network size={48} className="mb-4 text-muted-foreground" />
                  <p className="text-lg font-medium">{t('docker.noNetworks')}</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {t('docker.noNetworksDesc')}
                  </p>
                </CardContent>
              ) : (
                <CardContent className="p-0">
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead>
                        <tr className="border-b border-border text-left text-sm text-muted-foreground">
                          <th className="px-6 py-3 font-medium">{t('docker.colName')}</th>
                          <th className="px-6 py-3 font-medium">{t('docker.colDriver')}</th>
                          <th className="px-6 py-3 font-medium">{t('docker.colScope')}</th>
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
                  <p className="text-sm text-muted-foreground">{t('docker.loadingVolumes')}</p>
                </CardContent>
              ) : volumes.length === 0 ? (
                <CardContent className="flex flex-col items-center justify-center py-16">
                  <HardDrive size={48} className="mb-4 text-muted-foreground" />
                  <p className="text-lg font-medium">{t('docker.noVolumes')}</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {t('docker.noVolumesDesc')}
                  </p>
                </CardContent>
              ) : (
                <CardContent className="p-0">
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead>
                        <tr className="border-b border-border text-left text-sm text-muted-foreground">
                          <th className="px-6 py-3 font-medium">{t('docker.colName')}</th>
                          <th className="px-6 py-3 font-medium">{t('docker.colDriver')}</th>
                          <th className="px-6 py-3 font-medium">{t('docker.colMountpoint')}</th>
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
