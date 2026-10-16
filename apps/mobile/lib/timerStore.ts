import AsyncStorage from '@react-native-async-storage/async-storage';
import { createTimerStore } from './timerPersistence';
export const timerStore = createTimerStore(AsyncStorage);
