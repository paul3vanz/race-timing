import { Tabs } from 'expo-router';

import { IconSymbol } from '@/components/ui/icon-symbol';

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: '#0d0d0d' },
        headerTintColor: '#fff',
        tabBarStyle: { backgroundColor: '#0d0d0d', borderTopColor: '#1a1a1a' },
        tabBarActiveTintColor: '#4caf50',
        tabBarInactiveTintColor: '#555',
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Race Timing',
          tabBarLabel: 'Races',
          tabBarIcon: ({ color }) => <IconSymbol size={26} name="flag.fill" color={color} />,
        }}
      />
      <Tabs.Screen
        name="explore"
        options={{
          title: 'Settings',
          tabBarLabel: 'Settings',
          tabBarIcon: ({ color }) => <IconSymbol size={26} name="gearshape.fill" color={color} />,
        }}
      />
    </Tabs>
  );
}
