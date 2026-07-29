import { Stack } from 'expo-router';

export default function CreateJarLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        presentation: 'card',
      }}
    />
  );
}
