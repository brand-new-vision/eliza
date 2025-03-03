export interface Slots {
    [key: string]: string;
}

export interface Wearable {
    _id: string;
    aiDescription: string;
    slots: Slots;
}

export interface WearablesResponse {
    data: {
        wearables: Wearable[];
    };
}

export interface AvatarAttributes {
    skinTone: string;
    facialFeatures: string;
    eyewear: string;
    hat: string;
    top: string;
    bottom: string;
    shoes: string;
    accessories: string[];
}