import React, { useState } from 'react';
import { View, Text, TextInput, Button, StyleSheet } from 'react-native';
import { useTheme } from '../../contexts/ThemeContext';

export function CreateProject({ navigation }: { navigation: { goBack: () => void } }) {
  const { colors } = useTheme();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    try {
      // Placeholder for API call to create a project
      // await createProject({ name, description });
      navigation.goBack();
    } catch (e) {
      setError('Failed to create project');
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <Text style={[styles.title, { color: colors.text }]}>Create New Project</Text>
      {error && <Text style={[styles.error, { color: colors.accent }]}>{error}</Text>}
      <TextInput
        style={[styles.input, { borderColor: colors.border }]}
        placeholder="Project Name"
        value={name}
        onChangeText={setName}
      />
      <TextInput
        style={[styles.input, { borderColor: colors.border }]}
        placeholder="Project Description"
        value={description}
        onChangeText={setDescription}
      />
      <Button title="Create" onPress={handleSubmit} color={colors.accent} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16 },
  title: { fontSize: 22, fontWeight: '600', marginBottom: 12 },
  error: { marginBottom: 8 },
  input: {
    height: 40,
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 8,
    marginBottom: 12,
  },
});
