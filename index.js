import Header from "./components/Header";
import SensorGrid from "./components/SensorGrid";
import PlantProfile from "./components/PlantProfile";
import IrrigationPrediction from "./components/IrrigationPrediction";

function App() {
  return (
    <div className="dashboard">
      <Header />

      <SensorGrid />

      <div className="bottom-section">
        <PlantProfile />
        <IrrigationPrediction />
      </div>
    </div>
  );
}

export default App;