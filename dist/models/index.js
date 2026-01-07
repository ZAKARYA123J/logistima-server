import { Zone } from "./Zone.model.js";
import { Driver } from "./Driver.model.js";
import { Parcel } from "./Parcel.model.js";
import { Delivery } from "./Delivery.model.js";
// Zone
Zone.hasMany(Driver, { foreignKey: "zoneId" });
Zone.hasMany(Parcel, { foreignKey: "zoneId" });
// Driver
Driver.belongsTo(Zone, { foreignKey: "zoneId" });
Driver.hasMany(Parcel, { foreignKey: "driverId" });
Driver.hasMany(Delivery, { foreignKey: "driverId" });
// Parcel
Parcel.belongsTo(Zone, { foreignKey: "zoneId" });
Parcel.belongsTo(Driver, { foreignKey: "driverId" });
Parcel.hasOne(Delivery, { foreignKey: "parcelId" });
// Delivery
Delivery.belongsTo(Parcel, { foreignKey: "parcelId" });
Delivery.belongsTo(Driver, { foreignKey: "driverId" });
export { Zone, Driver, Parcel, Delivery };
