import React from 'react';
import { Home, Search, Heart, Settings } from 'lucide-react';
import { useI18nStore } from '../store/i18nStore';

interface BottomNavProps {
  currentTab: string;
  setCurrentTab: (tab: string) => void;
  onClearSelectedPlaylist: () => void;
}

export const BottomNav: React.FC<BottomNavProps> = ({
  currentTab,
  setCurrentTab,
  onClearSelectedPlaylist,
}) => {
  const { t } = useI18nStore();

  const tabs = [
    { id: 'home', label: t('Home', 'Главная'), icon: Home },
    { id: 'search', label: t('Search', 'Поиск'), icon: Search },
    { id: 'liked', label: t('Liked', 'Любимые'), icon: Heart },
    { id: 'settings', label: t('Settings', 'Настройки'), icon: Settings },
  ];

  return (
    <div className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-cat-mantle/95 backdrop-blur-lg border-t border-cat-surface0/30 px-3 pb-[env(safe-area-inset-bottom)] pt-2 select-none">
      <div className="flex items-center justify-around">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = currentTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => {
                setCurrentTab(tab.id);
                if (tab.id === 'home') {
                  onClearSelectedPlaylist();
                }
              }}
              className={`flex flex-col items-center justify-center py-1 px-3 rounded-xl transition-all ${
                isActive ? 'text-cat-mauve font-semibold' : 'text-cat-subtext0 hover:text-cat-text'
              }`}
            >
              <Icon className="w-5 h-5 mb-1" />
              <span className="text-[10px] tracking-tight">{tab.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
};
